/** Development Project Registry, registration recovery, and Projections. @module @breakfastdapaidang/saki-control-plane/projects */

import { randomUUID } from 'node:crypto'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import {
  canonicalDigest,
  inheritedChangeBaselineIdentityMaterial,
  projectInspectionFingerprintMaterial,
  projectInspectionWorkspaceIndependentMaterial,
  projectSelectionInspectionSchema,
} from '@breakfastdapaidang/saki-execution'
import type {
  ActiveHostProjectBinding,
  ProjectSelectionInspection,
  ProjectSelectionProjection,
  SakiHostExecution,
  WorkspaceId,
} from '@breakfastdapaidang/saki-execution'
import {
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
  agentProfileRecordSchema,
  developmentProjectRegistryRecordSchema,
  registrationIntentRecordSchema,
  resourceBindingRecordSchema,
} from './spec.ts'
import type {
  AgentProfileRecord,
  DevelopmentProjectRecord,
  DevelopmentProjectRegistryRecord,
  RegistrationActor,
  RegistrationIntentRecord,
  ResourceBindingRecord,
} from './spec.ts'
import type {
  RegisterDevelopmentProjectIntent,
  SakiControlIntentId,
  SakiAgentProfileId,
  SakiDevelopmentProjectId,
  SakiDevelopmentProjectSummary,
  SakiDevelopmentWorkspaceProjection,
  SakiHostChoiceProjection,
  SakiIntentReceipt,
  SakiIntentReceiptId,
  SakiProjectIndexProjection,
  SakiResourceBindingId,
} from './types.ts'

/** Exact active Host binding resolved from the trusted durable Registry. */
export interface ResolvedActiveProjectBinding {
  readonly registryRevision: number
  readonly projectId: SakiDevelopmentProjectId
  readonly projectRevision: number
  readonly binding: ActiveHostProjectBinding
}

/**
 * Derive the complete Host authority frozen for one active Binding revision.
 * @param resource - validated durable Resource Binding that owns the private evidence.
 * @param revision - Binding revision retained by the Host request.
 * @returns detached Host authority with no caller-supplied fields.
 */
export function activeHostProjectBinding(
  resource: ResourceBindingRecord,
  revision: number = resource.revision,
): ActiveHostProjectBinding {
  return {
    id: resource.id,
    revision,
    health: 'active',
    hostId: resource.hostId,
    workspaceId: resource.workspaceId,
    expectedInspection: cloneInspection(resource.registrationInspection),
    inheritedChangeBaseline: structuredClone(resource.inheritedChangeBaseline),
  }
}

type RegistryTable = KvTable<typeof DEVELOPMENT_PROJECT_REGISTRY_KEY, DevelopmentProjectRegistryRecord>
type IntentTable = KvTable<SakiControlIntentId, RegistrationIntentRecord>
type TerminalIntentPhase = 'confirmed' | 'conflict' | 'failure' | 'reconciliation-required'
type ReadonlyTable<K extends string, V> = Pick<KvTable<K, V>, 'entries'>
type RegistrationActorInvariant = Pick<RegistrationActor,
| 'installationId'
| 'hostId'
| 'principalId'
| 'principalRevision'
| 'grantId'
| 'grantRevision'>
type RegistrationIntentInvariant =
  Omit<RegistrationIntentRecord, 'schemaVersion' | 'payload'> & {
    readonly payload: Omit<RegistrationIntentRecord['payload'], 'actor'> & {
      readonly actor: RegistrationActorInvariant
    }
  }

interface ValidatedDevelopmentProjectsState<
  I extends RegistrationIntentInvariant = RegistrationIntentRecord,
> {
  readonly registry: DevelopmentProjectRegistryRecord | undefined
  readonly intents: readonly I[]
}

/**
 * Identify Registry children whose initial write admission is still recoverable by registration.
 * @param registry - validated current Project Registry.
 * @param intents - cross-validated current registration Intents.
 * @returns Binding ids committed before registration completed its admission handoff.
 */
export function recoverableRegistrationAdmissionBindingIds(
  registry: DevelopmentProjectRegistryRecord | undefined,
  intents: readonly RegistrationIntentRecord[],
): ReadonlySet<SakiResourceBindingId> {
  if (registry === undefined) return new Set()
  const intentById = new Map(intents.map(intent => [intent.id, intent] as const))
  return new Set(registry.intentMappings.flatMap((mapping) => {
    const intent = intentById.get(mapping.intentId)
    return intent?.phase === 'workspace-observed' || intent?.phase === 'registry-committed'
      ? [mapping.resourceBindingId]
      : []
  }))
}

interface CommittedRegistration {
  readonly projectId: SakiDevelopmentProjectId
  readonly resourceBindingId: SakiResourceBindingId
  readonly registryRevision: number
}

class RegistryConflict extends Error {
  constructor(readonly reason: 'expected-revision' | 'duplicate-binding') {
    super(reason)
    this.name = 'RegistryConflict'
  }
}

class IntentCasConflict extends Error {
  constructor() {
    super('registration Intent changed outside its serialized lifecycle')
    this.name = 'IntentCasConflict'
  }
}

/** New-Project values copied into its first immutable Agent Profile version. */
export interface DevelopmentProjectAgentProfileTemplate {
  readonly agentPresetId: AgentProfileRecord['agentPresetId']
  readonly modelRouteRequest: AgentProfileRecord['modelRouteRequest']
}

/** Durable dependencies owned by the control-plane facade. */
export interface DevelopmentProjectsOptions {
  readonly registryTable: RegistryTable
  readonly intentTable: IntentTable
  readonly execution: SakiHostExecution
  readonly workspaces: WorkspaceRegistry
  readonly authorityCurrent: (actor: RegistrationActor) => boolean
  readonly validateActorReference: (actor: RegistrationActor) => void
  readonly defaultAgentProfileTemplate: DevelopmentProjectAgentProfileTemplate
  /** Materialize or verify the Binding's single-writer admission before registration confirms. */
  readonly ensureBindingWriteAdmission?: (binding: ResourceBindingRecord) => Promise<void>
}

/**
 * Parse and cross-check one complete durable Project Registry and Intent collection without effects.
 * @param registryTable - Read-only Project Registry table.
 * @param intentTable - Read-only registration Intent table.
 * @param parseIntent - Version-specific parser for one already-opened Intent record.
 * @param validateActorReference - Version-specific Actor reference validator.
 * @returns detached validated state ordered for deterministic recovery.
 */
export function validateDevelopmentProjectsDurableState<
  RK extends string,
  I extends RegistrationIntentInvariant,
>(
  registryTable: ReadonlyTable<RK, DevelopmentProjectRegistryRecord>,
  intentTable: ReadonlyTable<SakiControlIntentId, I>,
  parseIntent: (value: I) => I,
  validateActorReference: (actor: I['payload']['actor']) => void,
): ValidatedDevelopmentProjectsState<I> {
  const registryEntries = [...registryTable.entries()]
  const intentEntries = [...intentTable.entries()]
  const registryEntry = registryEntries.at(0)
  if (registryEntries.length > 1
    || (registryEntry !== undefined && !isRegistryKey(registryEntry[0]))) {
    throw new Error('Saki Development Project Registry has an invalid singleton key')
  }
  const intents = intentEntries.map(([key, value]) => {
    const parsed = parseIntent(value)
    if (parsed.id !== key) throw new Error('Saki registration Intent id disagrees with its table key')
    validateActorReference(parsed.payload.actor)
    return parsed
  })
  const registry = registryEntry === undefined
    ? undefined
    : validateRegistry(registryEntry[1])
  if (registry === undefined && intents.length > 0) {
    throw new Error('Saki registration Intents exist without the Project Registry')
  }
  if (registry !== undefined) validateCrossRecords(registry, intents)
  return {
    registry,
    intents: intents.toSorted((left, right) =>
      left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id))),
  }
}

/** Durable Development Project aggregate and recoverable registration state machine. */
export class DevelopmentProjects {
  constructor(private readonly options: DevelopmentProjectsOptions) {}

  /**
   * Parse and cross-check every Project record without writes or external calls.
   * @returns immutable startup input for {@link initializeValidated}.
   */
  validateDurableState(): ValidatedDevelopmentProjectsState {
    return validateDevelopmentProjectsDurableState(
      this.options.registryTable,
      this.options.intentTable,
      value => registrationIntentRecordSchema.parse(value),
      (actor) => { this.options.validateActorReference(actor) },
    )
  }

  /**
   * Materialize a valid empty singleton, recover nonterminal Intents, and refresh bindings.
   * @param state - prior pure validation result for the whole durable Project state.
   * @param signal - control-plane initialization lifetime.
   */
  async initializeValidated(
    state: ValidatedDevelopmentProjectsState,
    signal: AbortSignal,
  ): Promise<void> {
    if (state.registry === undefined) {
      await this.options.registryTable.put(DEVELOPMENT_PROJECT_REGISTRY_KEY, emptyRegistry())
    }
    for (const intent of state.intents) {
      signal.throwIfAborted()
      if (!terminal(intent.phase)) await this.resume(intent.id, signal)
    }
    this.validateDurableState()
    await this.revalidateBindings(signal)
  }

  /**
   * Replay a known immutable Intent without repeating untrusted selection inspection.
   * @param intent - parsed incoming registration content.
   * @param signal - caller lifetime.
   * @returns stable result when the id exists, otherwise `undefined`.
   */
  async replayExisting(
    intent: RegisterDevelopmentProjectIntent,
    signal: AbortSignal,
  ): Promise<SakiIntentReceipt | undefined> {
    const existing = this.options.intentTable.get(intent.intentId)
    if (existing === undefined) return undefined
    const parsed = registrationIntentRecordSchema.parse(existing)
    if (!sameIncomingIntent(parsed, intent)) return { ok: false, reason: 'conflict' }
    return await this.resume(parsed.id, signal)
  }

  /**
   * Prepare or replay one registration after Host inspection and authority checks.
   * @param intent - parsed browser-supplied registration content.
   * @param actor - current server-derived authority evidence for a new Intent.
   * @param inspection - fresh Host observation matching the browser confirmation.
   * @param signal - caller lifetime.
   * @returns stable terminal or recoverable result.
   */
  async register(
    intent: RegisterDevelopmentProjectIntent,
    actor: RegistrationActor,
    inspection: ProjectSelectionInspection,
    signal: AbortSignal,
  ): Promise<SakiIntentReceipt> {
    signal.throwIfAborted()
    const existing = this.options.intentTable.get(intent.intentId)
    if (existing !== undefined) {
      const parsed = registrationIntentRecordSchema.parse(existing)
      if (!sameIncomingIntent(parsed, intent)) return { ok: false, reason: 'conflict' }
      return await this.resume(parsed.id, signal)
    }
    const payload = { intent, actor }
    const now = Date.now()
    const record = registrationIntentRecordSchema.parse({
      id: intent.intentId,
      schemaVersion: 2,
      revision: 0,
      receiptId: receiptId(intent.intentId),
      payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
      payload,
      inspection: projectSelectionInspectionSchema.parse(inspection),
      phase: 'prepared',
      createdAt: now,
      updatedAt: now,
    })
    await this.options.intentTable.put(record.id, record)
    return await this.resume(record.id, signal, record.inspection)
  }

  /**
   * Read the validated singleton aggregate.
   * @returns a detached parsed Registry record.
   */
  registry(): DevelopmentProjectRegistryRecord {
    const record = this.options.registryTable.get(DEVELOPMENT_PROJECT_REGISTRY_KEY)
    if (record === undefined) throw new Error('Saki Development Project Registry is absent')
    return validateRegistry(record)
  }

  /**
   * Project the current registry for one enrolled Host.
   * @param host - current display-safe Host choice.
   * @returns detached Project index.
   */
  projectIndex(host: SakiHostChoiceProjection): SakiProjectIndexProjection {
    const registry = this.registry()
    return {
      type: 'project-index',
      revision: registry.revision,
      hosts: [host],
      projects: registry.projects.map(project => summary(registry, project)),
    }
  }

  /**
   * Resolve one Project detail at an exact caller-observed registry revision.
   * @param projectId - stable Project identity.
   * @param expectedRevision - exact Project Registry revision.
   * @returns detached workspace Projection, `stale`, or `not-found`.
   */
  developmentWorkspace(
    projectId: SakiDevelopmentProjectId,
    expectedRevision: number,
  ): SakiDevelopmentWorkspaceProjection | 'stale' | 'not-found' {
    const registry = this.registry()
    if (registry.revision !== expectedRevision) return 'stale'
    const project = registry.projects.find(candidate => candidate.id === projectId)
    if (project === undefined) return 'not-found'
    const binding = bindingFor(registry, project)
    const current = binding.currentInspection?.projection
    const reasons = [
      ...(binding.health === 'missing' ? ['binding-missing' as const] : []),
      ...(binding.health === 'repair-required' ? ['binding-repair-required' as const] : []),
      ...(binding.inheritedChangeBaseline.kind === 'unavailable'
        || current?.blockingReasons.includes('baseline-unavailable')
        ? ['baseline-unavailable' as const] : []),
      ...(current?.blockingReasons.includes('conversion-ambiguous')
        ? ['conversion-ambiguous' as const] : []),
      ...(current?.blockingReasons.includes('dirty') ? ['dirty' as const] : []),
      ...(current?.blockingReasons.includes('locked') ? ['locked' as const] : []),
    ]
    return {
      type: 'development-workspace',
      registryRevision: registry.revision,
      project: summary(registry, project),
      ...(current === undefined ? {} : { currentSelection: structuredClone(current) }),
      recovery: { state: reasons.length === 0 ? 'ready' : 'blocked', reasons },
    }
  }

  /**
   * Resolve trusted active Host evidence at an exact caller-observed Registry revision.
   * @param projectId - stable Project identity.
   * @param expectedRevision - exact Project Registry revision.
   * @returns detached trusted binding evidence or a bounded lookup failure.
   */
  activeBinding(
    projectId: SakiDevelopmentProjectId,
    expectedRevision: number,
  ): ResolvedActiveProjectBinding | 'stale' | 'not-found' | 'binding-unavailable' {
    const registry = this.registry()
    if (registry.revision !== expectedRevision) return 'stale'
    return this.resolveActiveBinding(registry, projectId)
  }

  /**
   * Resolve one Project's current active Binding without coupling effect-boundary admission
   * to unrelated Registry revision advances.
   * @param projectId - stable Project identity retained by the accepted Intent.
   * @returns current trusted binding evidence or a bounded lookup failure.
   */
  currentActiveBinding(
    projectId: SakiDevelopmentProjectId,
  ): ResolvedActiveProjectBinding | 'not-found' | 'binding-unavailable' {
    return this.resolveActiveBinding(this.registry(), projectId)
  }

  private resolveActiveBinding(
    registry: DevelopmentProjectRegistryRecord,
    projectId: SakiDevelopmentProjectId,
  ): ResolvedActiveProjectBinding | 'not-found' | 'binding-unavailable' {
    const project = registry.projects.find(candidate => candidate.id === projectId)
    if (project === undefined) return 'not-found'
    const resource = bindingFor(registry, project)
    if (resource.health !== 'active') return 'binding-unavailable'
    return {
      registryRevision: registry.revision,
      projectId: project.id,
      projectRevision: project.revision,
      binding: activeHostProjectBinding(resource),
    }
  }

  private async resume(
    intentId: SakiControlIntentId,
    signal: AbortSignal,
    initialFreshInspection?: ProjectSelectionInspection,
  ): Promise<SakiIntentReceipt> {
    let fresh = initialFreshInspection
    while (true) {
      signal.throwIfAborted()
      let record = this.requireIntent(intentId)
      if (terminal(record.phase)) return receiptFor(record)

      if (record.phase === 'prepared') {
        if (!this.options.authorityCurrent(record.payload.actor)) {
          return receiptFor(await this.terminal(record, 'failure', 'authority'))
        }
        if (fresh === undefined) {
          const inspected = await this.inspectRetainedCanonicalForRecovery(record, signal)
          if (!inspected.ok) return inspected.receipt
          fresh = inspected.inspection
        }
        if (!sameFullInspection(record.inspection, fresh)) {
          return receiptFor(await this.terminal(record, 'reconciliation-required', 'observation'))
        }
        record = await this.transition(record, { phase: 'workspace-dispatching' })
        fresh = undefined
        continue
      }

      if (record.phase === 'workspace-dispatching') {
        const inspected = await this.inspectRetainedCanonicalForRecovery(record, signal)
        if (!inspected.ok) return inspected.receipt
        fresh = inspected.inspection
        if (!sameWorkspaceIndependentInspection(record.inspection, fresh)) {
          return receiptFor(await this.terminal(record, 'reconciliation-required', 'observation'))
        }
        const originalWorkspaceId = record.inspection.projection.workspaceId
        const currentWorkspaceId = fresh.projection.workspaceId
        if (originalWorkspaceId !== undefined) {
          if (currentWorkspaceId === undefined
            || currentWorkspaceId !== originalWorkspaceId
            || !this.workspaceMatches(fresh, originalWorkspaceId)) {
            return receiptFor(await this.terminal(record, 'reconciliation-required', 'workspace'))
          }
          await this.transition(record, {
            phase: 'workspace-observed',
            workspaceId: originalWorkspaceId,
            workspaceInspection: cloneInspection(fresh),
          })
          fresh = undefined
          continue
        }
        if (currentWorkspaceId !== undefined) {
          if (!this.workspaceMatches(fresh, currentWorkspaceId)) {
            return receiptFor(await this.terminal(record, 'reconciliation-required', 'workspace'))
          }
          await this.transition(record, {
            phase: 'workspace-observed',
            workspaceId: currentWorkspaceId,
            workspaceInspection: cloneInspection(fresh),
          })
          fresh = undefined
          continue
        }
        if (!this.options.authorityCurrent(record.payload.actor)) {
          return receiptFor(await this.terminal(record, 'failure', 'authority'))
        }
        let workspace: Awaited<ReturnType<WorkspaceRegistry['create']>>
        try {
          workspace = await this.options.workspaces.create(
            fresh.trusted.canonicalWorktreePath,
            record.payload.intent.projectTitle,
          )
        } catch {
          signal.throwIfAborted()
          return receiptFor(record)
        }
        await this.transition(record, {
          phase: 'workspace-observed',
          workspaceId: workspace.id,
        })
        fresh = undefined
        continue
      }

      if (record.phase === 'workspace-observed') {
        const registry = this.registry()
        const mapped = mappingFor(registry, record.id)
        if (mapped !== undefined) {
          await this.transition(record, {
            phase: 'registry-committed',
            workspaceInspection: record.workspaceInspection,
            projectId: mapped.projectId,
            resourceBindingId: mapped.resourceBindingId,
            registryRevision: mapped.registryRevision,
          })
          fresh = undefined
          continue
        }
        const workspaceId = record.workspaceId as WorkspaceId
        const inspected = await this.inspectRetainedCanonicalForRecovery(record, signal)
        if (!inspected.ok) return inspected.receipt
        fresh = inspected.inspection
        if (!sameWorkspaceIndependentInspection(record.inspection, fresh)
          || fresh.projection.workspaceId === undefined
          || fresh.projection.workspaceId !== workspaceId
          || !this.workspaceMatches(fresh, workspaceId)) {
          return receiptFor(await this.terminal(record, 'reconciliation-required', 'observation', fresh))
        }
        record = await this.transition(record, {
          phase: 'workspace-observed',
          workspaceInspection: cloneInspection(fresh),
        })
        try {
          const committed = await this.commitRegistry(record, workspaceId, fresh)
          await this.transition(record, {
            phase: 'registry-committed',
            projectId: committed.projectId,
            resourceBindingId: committed.resourceBindingId,
            registryRevision: committed.registryRevision,
          })
        } catch (error) {
          if (error instanceof RegistryConflict) {
            return receiptFor(await this.terminal(record, 'conflict', error.reason))
          }
          throw error
        }
        fresh = undefined
        continue
      }

      const bindingId = record.resourceBindingId
      /* v8 ignore next -- the record schema requires commit identities in this phase. */
      if (bindingId === undefined) throw new Error('registry-committed Intent lacks its Resource Binding')
      const binding = this.registry().resourceBindings.find(candidate => candidate.id === bindingId)
      /* v8 ignore next -- durable cross-record validation requires the committed child. */
      if (binding === undefined) throw new Error('registry-committed Intent references a missing Resource Binding')
      await this.options.ensureBindingWriteAdmission?.(binding)
      await this.transition(record, { phase: 'confirmed' })
      fresh = undefined
    }
  }

  /**
   * Reinspect the retained canonical worktree path only as a locator.
   * The returned fresh Host observation supplies authority for later Workspace access.
   */
  private async inspectRetainedCanonicalForRecovery(
    record: RegistrationIntentRecord,
    signal: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly inspection: ProjectSelectionInspection }
    | { readonly ok: false; readonly receipt: SakiIntentReceipt }
  > {
    const inspected = await this.options.execution.inspectProjectSelection({
      hostId: record.payload.intent.hostId,
      directoryLocator: record.inspection.trusted.canonicalWorktreePath,
    }, signal)
    signal.throwIfAborted()
    if (inspected.ok) return { ok: true, inspection: cloneInspection(inspected.inspection) }
    if (inspected.reason === 'unavailable') return { ok: false, receipt: receiptFor(record) }
    return {
      ok: false,
      receipt: receiptFor(await this.terminal(record, 'reconciliation-required', 'observation')),
    }
  }

  private workspaceMatches(inspection: ProjectSelectionInspection, workspaceId: WorkspaceId): boolean {
    const matches = this.options.workspaces.list().filter(workspace =>
      workspace.path === inspection.trusted.canonicalWorktreePath)
    return matches.length === 1 && matches[0]?.id === workspaceId
  }

  private async commitRegistry(
    intent: RegistrationIntentRecord,
    workspaceId: WorkspaceId,
    currentInspection: ProjectSelectionInspection,
  ): Promise<CommittedRegistration> {
    const candidateProjectId = `project-${randomUUID()}` as SakiDevelopmentProjectId
    const candidateBindingId = `binding-${randomUUID()}` as SakiResourceBindingId
    const candidateAgentProfileId = `agent-profile-${randomUUID()}` as SakiAgentProfileId
    const intentSnapshot = this.readIntents()
    await this.options.registryTable.update(DEVELOPMENT_PROJECT_REGISTRY_KEY, (currentValue) => {
      const registry = validateRegistry(currentValue)
      if (registry.revision !== intent.payload.intent.expectedRegistryRevision) {
        throw new RegistryConflict('expected-revision')
      }
      const trusted = intent.inspection.trusted
      const hostId = intent.payload.intent.hostId
      if (registry.canonicalWorktreeIndex.some(entry =>
        entry.hostId === hostId && entry.path === trusted.canonicalWorktreePath)
        || registry.gitDirectoryIndex.some(entry =>
          entry.hostId === hostId && entry.path === trusted.canonicalGitDirectory)) {
        throw new RegistryConflict('duplicate-binding')
      }
      const now = Math.max(intent.createdAt, Date.now())
      const registryRevision = registry.revision + 1
      const project: DevelopmentProjectRecord = {
        id: candidateProjectId,
        revision: 0,
        projectTitle: intent.payload.intent.projectTitle,
        resourceBindingId: candidateBindingId,
        defaultAgentProfileId: candidateAgentProfileId,
        state: 'active',
        createdAt: now,
      }
      const agentProfile = agentProfileRecordSchema.parse({
        id: candidateAgentProfileId,
        projectId: candidateProjectId,
        version: 1,
        ...this.options.defaultAgentProfileTemplate,
        createdAt: now,
      })
      const binding = resourceBindingRecordSchema.parse({
        id: candidateBindingId,
        revision: 0,
        projectId: candidateProjectId,
        hostId: intent.payload.intent.hostId,
        workspaceId,
        health: 'active',
        registrationInspection: cloneInspection(intent.inspection),
        currentInspection: cloneInspection(currentInspection),
        inheritedChangeBaseline: intent.payload.intent.confirmedBaseline,
        createdAt: now,
        observedAt: now,
      })
      const next = validateRegistry({
        ...registry,
        revision: registryRevision,
        projects: [...registry.projects, project],
        agentProfiles: [...registry.agentProfiles, agentProfile],
        resourceBindings: [...registry.resourceBindings, binding],
        canonicalWorktreeIndex: [...registry.canonicalWorktreeIndex, {
          hostId,
          path: trusted.canonicalWorktreePath,
          resourceBindingId: candidateBindingId,
        }],
        gitDirectoryIndex: [...registry.gitDirectoryIndex, {
          hostId,
          path: trusted.canonicalGitDirectory,
          resourceBindingId: candidateBindingId,
        }],
        intentMappings: [...registry.intentMappings, {
          intentId: intent.id,
          projectId: candidateProjectId,
          resourceBindingId: candidateBindingId,
          registryRevision,
        }],
      })
      validateCrossRecords(next, intentSnapshot)
      return next
    })
    return {
      projectId: candidateProjectId,
      resourceBindingId: candidateBindingId,
      registryRevision: intent.payload.intent.expectedRegistryRevision + 1,
    }
  }

  private async revalidateBindings(signal: AbortSignal): Promise<void> {
    const snapshot = this.registry()
    for (const binding of snapshot.resourceBindings) {
      signal.throwIfAborted()
      const inspected = await this.options.execution.inspectProjectSelection({
        hostId: binding.hostId,
        directoryLocator: binding.registrationInspection.trusted.canonicalWorktreePath,
      }, signal)
      signal.throwIfAborted()
      let health: ResourceBindingRecord['health']
      let currentInspection: ProjectSelectionInspection | undefined
      if (!inspected.ok) {
        health = inspected.reason === 'missing' ? 'missing' : 'repair-required'
      } else {
        const fresh = cloneInspection(inspected.inspection)
        const sameIdentity = fresh.trusted.canonicalWorktreePath
            === binding.registrationInspection.trusted.canonicalWorktreePath
          && fresh.trusted.canonicalGitDirectory
            === binding.registrationInspection.trusted.canonicalGitDirectory
          && fresh.trusted.canonicalCommonGitDirectory
            === binding.registrationInspection.trusted.canonicalCommonGitDirectory
          && fresh.trusted.gitDirectoryIdentity.digest
            === binding.registrationInspection.trusted.gitDirectoryIdentity.digest
          && fresh.trusted.commonGitDirectoryIdentity.digest
            === binding.registrationInspection.trusted.commonGitDirectoryIdentity.digest
        const workspace = this.options.workspaces.list().find(candidate => candidate.id === binding.workspaceId)
        const sameWorkspace = fresh.projection.workspaceId !== undefined
          && fresh.projection.workspaceId === binding.workspaceId
          && workspace?.path === fresh.trusted.canonicalWorktreePath
        health = sameIdentity && sameWorkspace ? 'active' : 'repair-required'
        if (sameIdentity && fresh.projection.workspaceId === binding.workspaceId) currentInspection = fresh
      }
      const sameCurrent = currentInspection?.projection.fingerprint.digest
        === binding.currentInspection?.projection.fingerprint.digest
      if (health === binding.health && sameCurrent) {
        continue
      }
      const intentSnapshot = this.readIntents()
      await this.options.registryTable.update(DEVELOPMENT_PROJECT_REGISTRY_KEY, (currentValue) => {
        const registry = validateRegistry(currentValue)
        const index = registry.resourceBindings.findIndex(candidate => candidate.id === binding.id)
        const current = registry.resourceBindings[index]
        if (current === undefined || current.revision !== binding.revision) {
          throw new Error('Resource Binding changed during serialized startup revalidation')
        }
        const { currentInspection: _previousInspection, ...currentWithoutInspection } = current
        const observedAt = Math.max(current.observedAt, Date.now())
        const nextBinding = resourceBindingRecordSchema.parse({
          ...currentWithoutInspection,
          revision: current.revision + 1,
          health,
          ...(currentInspection === undefined ? {} : { currentInspection }),
          observedAt,
        })
        const resourceBindings = [...registry.resourceBindings]
        resourceBindings[index] = nextBinding
        const next = validateRegistry({
          ...registry,
          revision: registry.revision + 1,
          resourceBindings,
        })
        validateCrossRecords(next, intentSnapshot)
        return next
      })
    }
  }

  private requireIntent(id: SakiControlIntentId): RegistrationIntentRecord {
    return registrationIntentRecordSchema.parse(this.options.intentTable.get(id))
  }

  private readIntents(): RegistrationIntentRecord[] {
    return [...this.options.intentTable.entries()].map(([, value]) => registrationIntentRecordSchema.parse(value))
  }

  private async transition(
    current: RegistrationIntentRecord,
    values: Partial<Pick<RegistrationIntentRecord,
      'phase' | 'workspaceId' | 'workspaceInspection' | 'projectId' | 'resourceBindingId' | 'registryRevision'>>,
  ): Promise<RegistrationIntentRecord> {
    return await this.updateIntent(current, values)
  }

  private async terminal(
    current: RegistrationIntentRecord,
    phase: Exclude<TerminalIntentPhase, 'confirmed'>,
    terminalReason: NonNullable<RegistrationIntentRecord['terminalReason']>,
    workspaceInspection?: ProjectSelectionInspection,
  ): Promise<RegistrationIntentRecord> {
    return await this.updateIntent(current, {
      phase,
      terminalReason,
      ...(workspaceInspection === undefined ? {} : { workspaceInspection: cloneInspection(workspaceInspection) }),
    })
  }

  private async updateIntent(
    current: RegistrationIntentRecord,
    values: Partial<Pick<RegistrationIntentRecord,
      'phase' | 'workspaceId' | 'workspaceInspection' | 'projectId' | 'resourceBindingId' | 'registryRevision'
      | 'terminalReason'>>,
  ): Promise<RegistrationIntentRecord> {
    return await this.options.intentTable.update(current.id, (storedValue) => {
      const stored = registrationIntentRecordSchema.parse(storedValue)
      if (stored.revision !== current.revision || stored.phase !== current.phase) {
        throw new IntentCasConflict()
      }
      return registrationIntentRecordSchema.parse({
        ...stored,
        ...values,
        revision: stored.revision + 1,
        updatedAt: Math.max(stored.updatedAt, Date.now()),
      })
    })
  }
}

function emptyRegistry(): DevelopmentProjectRegistryRecord {
  return developmentProjectRegistryRecordSchema.parse({
    id: DEVELOPMENT_PROJECT_REGISTRY_KEY,
    schemaVersion: 2,
    revision: 0,
    projects: [],
    agentProfiles: [],
    resourceBindings: [],
    canonicalWorktreeIndex: [],
    gitDirectoryIndex: [],
    intentMappings: [],
  })
}

function validateRegistry(value: DevelopmentProjectRegistryRecord): DevelopmentProjectRegistryRecord {
  const registry = developmentProjectRegistryRecordSchema.parse(value)
  unique(registry.projects.map(project => project.id), 'Project')
  unique(registry.agentProfiles.map(profile => profile.id), 'Agent Profile')
  unique(registry.resourceBindings.map(binding => binding.id), 'Resource Binding')
  unique(registry.resourceBindings.map(binding => binding.workspaceId), 'Workspace')
  unique(registry.projects.map(project => project.resourceBindingId), 'Project-to-Binding reference')
  unique(registry.resourceBindings.map(binding => binding.projectId), 'Binding-to-Project reference')
  unique(registry.canonicalWorktreeIndex.map(entry => hostPathKey(entry.hostId, entry.path)), 'canonical worktree')
  unique(registry.gitDirectoryIndex.map(entry => hostPathKey(entry.hostId, entry.path)), 'per-worktree Git directory')
  unique(registry.intentMappings.map(mapping => mapping.intentId), 'registration Intent mapping')
  unique(registry.intentMappings.map(mapping => mapping.projectId), 'mapped Project')
  unique(registry.intentMappings.map(mapping => mapping.resourceBindingId), 'mapped Resource Binding')
  unique(registry.intentMappings.map(mapping => String(mapping.registryRevision)), 'mapping commit revision')
  if (registry.projects.length !== registry.resourceBindings.length
    || registry.projects.length !== registry.canonicalWorktreeIndex.length
    || registry.projects.length !== registry.gitDirectoryIndex.length
    || registry.projects.length !== registry.intentMappings.length) {
    throw new Error('Saki Project Registry child and index cardinalities disagree')
  }
  for (const project of registry.projects) {
    const binding = registry.resourceBindings.find(candidate => candidate.id === project.resourceBindingId)
    if (binding?.projectId !== project.id) throw new Error(`Project '${project.id}' has an inconsistent Resource Binding`)
    const profile = registry.agentProfiles.find(candidate => candidate.id === project.defaultAgentProfileId)
    if (profile?.projectId !== project.id) {
      throw new Error(`Project '${project.id}' has an inconsistent default Agent Profile`)
    }
  }
  for (const profile of registry.agentProfiles) {
    if (!registry.projects.some(project => project.id === profile.projectId)) {
      throw new Error(`Agent Profile '${profile.id}' belongs to an unknown Project`)
    }
  }
  for (const binding of registry.resourceBindings) {
    const worktreeEntries = registry.canonicalWorktreeIndex.filter(entry =>
      entry.resourceBindingId === binding.id
      && entry.hostId === binding.hostId
      && entry.path === binding.registrationInspection.trusted.canonicalWorktreePath)
    const gitEntries = registry.gitDirectoryIndex.filter(entry =>
      entry.resourceBindingId === binding.id
      && entry.hostId === binding.hostId
      && entry.path === binding.registrationInspection.trusted.canonicalGitDirectory)
    if (worktreeEntries.length !== 1 || gitEntries.length !== 1) {
      throw new Error(`Resource Binding '${binding.id}' has inconsistent path indices`)
    }
  }
  for (const mapping of registry.intentMappings) {
    const project = registry.projects.find(candidate => candidate.id === mapping.projectId)
    const binding = registry.resourceBindings.find(candidate => candidate.id === mapping.resourceBindingId)
    if (project === undefined || binding === undefined || project.resourceBindingId !== binding.id
      || mapping.registryRevision > registry.revision) {
      throw new Error(`registration Intent '${mapping.intentId}' maps to inconsistent children`)
    }
  }
  return registry
}

function validateCrossRecords(
  registry: DevelopmentProjectRegistryRecord,
  intentValues: readonly RegistrationIntentInvariant[],
): void {
  const intents = new Map(intentValues.map(value => [value.id, value] as const))
  for (const mapping of registry.intentMappings) {
    const intent = intents.get(mapping.intentId)
    if (intent === undefined) throw new Error(`registration mapping '${mapping.intentId}' has no Intent`)
    if (terminal(intent.phase) && intent.phase !== 'confirmed') {
      throw new Error(`terminal registration Intent '${intent.id}' must not retain a mapping`)
    }
    if (intent.phase !== 'workspace-observed'
      && intent.phase !== 'registry-committed'
      && intent.phase !== 'confirmed') {
      throw new Error(`registration Intent '${intent.id}' maps before its Workspace observation`)
    }
    if (mapping.registryRevision !== intent.payload.intent.expectedRegistryRevision + 1) {
      throw new Error(`registration Intent '${intent.id}' has an invalid commit revision`)
    }
    const project = registry.projects.find(candidate => candidate.id === mapping.projectId) as DevelopmentProjectRecord
    const binding = registry.resourceBindings.find(candidate =>
      candidate.id === mapping.resourceBindingId) as ResourceBindingRecord
    if (project.projectTitle !== intent.payload.intent.projectTitle
      || project.revision !== 0
      || binding.hostId !== intent.payload.intent.hostId
      || binding.workspaceId !== intent.workspaceId
      || !canonicalEqual('saki/registration-inspection/exact/v1', binding.registrationInspection, intent.inspection)
      || !canonicalEqual('saki/confirmed-baseline/exact/v1',
        binding.inheritedChangeBaseline, intent.payload.intent.confirmedBaseline)) {
      throw new Error(`registration Intent '${intent.id}' disagrees with its committed children`)
    }
    if (intent.phase === 'workspace-observed' || intent.phase === 'registry-committed') {
      if (intent.workspaceInspection === undefined
        || binding.revision !== 0
        || binding.currentInspection === undefined
        || !sameWorkspaceIndependentInspection(intent.inspection, binding.currentInspection)
        || !canonicalEqual('saki/registration-current-inspection/exact/v1',
          binding.currentInspection, intent.workspaceInspection)) {
        throw new Error(`registration Intent '${intent.id}' has invalid initial binding evidence`)
      }
    }
    if (intent.phase === 'confirmed' && binding.revision === 0
      && !canonicalEqual('saki/registration-current-inspection/exact/v1',
        binding.currentInspection, intent.workspaceInspection)) {
      throw new Error(`registration Intent '${intent.id}' disagrees with its initial current inspection`)
    }
    if (binding.revision > registry.revision - mapping.registryRevision) {
      throw new Error(`registration Intent '${intent.id}' has an unreachable binding revision`)
    }
    if ((intent.phase === 'registry-committed' || intent.phase === 'confirmed')
      && (intent.projectId !== mapping.projectId
        || intent.resourceBindingId !== mapping.resourceBindingId)) {
      throw new Error(`registration Intent '${intent.id}' disagrees with its commit mapping`)
    }
  }
  for (const intent of intents.values()) {
    const mapping = mappingFor(registry, intent.id)
    if ((intent.phase === 'registry-committed' || intent.phase === 'confirmed') && mapping === undefined) {
      throw new Error(`committed registration Intent '${intent.id}' has no mapping`)
    }
  }
}

function unique(values: readonly string[], name: string): void {
  const result = new Set(values)
  if (result.size !== values.length) throw new Error(`Saki registry repeats ${name} identity`)
}

function hostPathKey(hostId: string, path: string): string {
  return `${hostId}\0${path}`
}

function isRegistryKey(value: unknown): value is typeof DEVELOPMENT_PROJECT_REGISTRY_KEY {
  return value === DEVELOPMENT_PROJECT_REGISTRY_KEY
}

function summary(
  registry: DevelopmentProjectRegistryRecord,
  project: DevelopmentProjectRecord,
): SakiDevelopmentProjectSummary {
  const binding = bindingFor(registry, project)
  const selection = binding.currentInspection?.projection ?? binding.registrationInspection.projection
  const configurationGaps = [
    ...(binding.inheritedChangeBaseline.kind === 'unavailable'
      || selection.blockingReasons.includes('baseline-unavailable')
      ? ['baseline-unavailable' as const] : []),
    ...(selection.conversionAmbiguous ? ['conversion-ambiguous' as const] : []),
    ...(binding.health === 'missing' ? ['binding-missing' as const] : []),
    ...(binding.health === 'repair-required' ? ['binding-repair-required' as const] : []),
  ]
  return {
    id: project.id,
    revision: project.revision,
    projectTitle: project.projectTitle,
    binding: {
      id: binding.id,
      revision: binding.revision,
      health: binding.health,
      hostId: binding.hostId,
      displayLocation: selection.displayLocation,
      objectFormat: selection.objectFormat,
      head: selection.head,
      inheritedChangeEntryCount: selection.inheritedChangeEntryCount,
      baseline: binding.inheritedChangeBaseline.kind,
      automaticMutationEligible: binding.health === 'active'
        && binding.inheritedChangeBaseline.kind === 'complete'
        && selection.automaticMutationEligible,
      configurationGaps,
    },
  }
}

function bindingFor(
  registry: DevelopmentProjectRegistryRecord,
  project: DevelopmentProjectRecord,
): ResourceBindingRecord {
  return registry.resourceBindings.find(candidate =>
    candidate.id === project.resourceBindingId) as ResourceBindingRecord
}

function cloneInspection(value: ProjectSelectionInspection): ProjectSelectionInspection {
  return projectSelectionInspectionSchema.parse(value)
}

function sameIncomingIntent(
  record: RegistrationIntentRecord,
  intent: RegisterDevelopmentProjectIntent,
): boolean {
  return canonicalDigest('saki/register-development-project/v1', {
    intent,
    actor: record.payload.actor,
  }) === record.payloadDigest
}

function sameFullInspection(
  left: ProjectSelectionInspection,
  right: ProjectSelectionInspection,
): boolean {
  return canonicalEqual(
    'saki/project-inspection/full-material/v1',
    projectInspectionFingerprintMaterial(left.projection, left.trusted),
    projectInspectionFingerprintMaterial(right.projection, right.trusted),
  )
}

function sameWorkspaceIndependentInspection(
  left: ProjectSelectionInspection,
  right: ProjectSelectionInspection,
): boolean {
  return canonicalEqual(
    'saki/project-inspection/workspace-independent/v1',
    projectInspectionWorkspaceIndependentMaterial(left.projection, left.trusted),
    projectInspectionWorkspaceIndependentMaterial(right.projection, right.trusted),
  )
}

/**
 * Compare baseline identity while excluding capture timestamp and elapsed duration.
 * @param observed - fresh baseline evidence.
 * @param confirmed - browser-confirmed baseline evidence.
 * @returns whether every stable baseline fact is equal.
 */
export function baselineMatches(
  observed: ProjectSelectionProjection['baseline'],
  confirmed: ProjectSelectionProjection['baseline'],
): boolean {
  return canonicalEqual(
    'saki/inherited-baseline/identity/v1',
    inheritedChangeBaselineIdentityMaterial(observed),
    inheritedChangeBaselineIdentityMaterial(confirmed),
  )
}

function canonicalEqual(domain: string, left: unknown, right: unknown): boolean {
  return canonicalDigest(domain, left) === canonicalDigest(domain, right)
}

function mappingFor(
  registry: DevelopmentProjectRegistryRecord,
  intentId: SakiControlIntentId,
): DevelopmentProjectRegistryRecord['intentMappings'][number] | undefined {
  return registry.intentMappings.find(mapping => mapping.intentId === intentId)
}

function terminal(phase: RegistrationIntentRecord['phase']): phase is TerminalIntentPhase {
  return phase === 'confirmed'
    || phase === 'conflict'
    || phase === 'failure'
    || phase === 'reconciliation-required'
}

function receiptFor(record: RegistrationIntentRecord): SakiIntentReceipt {
  const base = {
    id: record.receiptId,
    intentId: record.id,
  }
  if (record.phase === 'confirmed') {
    return {
      ok: true,
      receipt: {
        ...base,
        state: 'confirmed',
        projectId: record.projectId as SakiDevelopmentProjectId,
        resourceBindingId: record.resourceBindingId as SakiResourceBindingId,
        registryRevision: record.registryRevision as number,
      },
    }
  }
  if (record.phase === 'conflict') {
    return {
      ok: false,
      reason: 'conflict',
      receipt: {
        ...base,
        state: 'conflict',
        reason: record.terminalReason as 'expected-revision' | 'duplicate-binding',
      },
    }
  }
  if (record.phase === 'failure') {
    return {
      ok: false,
      reason: 'failure',
      receipt: { ...base, state: 'failure', reason: 'authority' },
    }
  }
  if (record.phase === 'reconciliation-required') {
    return {
      ok: false,
      reason: 'reconciliation-required',
      receipt: {
        ...base,
        state: 'reconciliation-required',
        reason: record.terminalReason as 'workspace' | 'observation',
      },
    }
  }
  return { ok: false, reason: 'unavailable', receipt: { ...base, state: 'prepared' } }
}

function receiptId(intentId: SakiControlIntentId): SakiIntentReceiptId {
  return intentId.replace(/^intent-/u, 'receipt-') as SakiIntentReceiptId
}
