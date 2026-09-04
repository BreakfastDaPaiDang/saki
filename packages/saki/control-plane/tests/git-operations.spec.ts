import { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'
import {
  canonicalDigest,
  computeProjectGitChangeFingerprint,
  computeProjectGitChangeId,
  computeProjectGitStatusFingerprint,
  computeProjectGitStatusSeedDigest,
  computeProjectInspectionFingerprint,
  hostOperationIdSchema,
  HostOperationAcceptance,
  SakiHostExecution,
} from '@breakfastdapaidang/saki-execution'
import type {
  HostOperationAdmissionExpectation,
  HostOperationAdmissionSource,
  HostOperationCancellationReason,
  HostOperationChange,
  HostOperationKind,
  HostOperationPreparation,
  HostOperationReceipt,
  HostOperationReference,
  HostOperationRequest,
  HostOperationSnapshot,
  HostOperationStartResult,
  InspectProjectResult,
  InterventionOpeningEvidence,
  ProjectGitChangeFingerprintMaterial,
  ProjectGitStatusObservation,
  ProjectGitStatusSeedMaterial,
} from '@breakfastdapaidang/saki-execution'
import { SAKI_PROJECT_PROJECTION_FIXTURES } from '../src/fixtures.ts'
import { GitOperations, validateGitOperationsDurableState } from '../src/git-operations.ts'
import {
  bindingWriteAdmissionRecordSchema,
  createCommitIntentSchema,
  developmentProjectRegistryRecordSchema,
  gitOperationIntentRecordSchema,
  resourceBindingRecordSchema,
  stageFilesIntentSchema,
  unstageFilesIntentSchema,
} from '../src/spec.ts'
import type {
  BindingWriteAdmissionRecord,
  ControlIntentActor,
  DevelopmentProjectRegistryRecord,
  GitOperationIntentRecord,
} from '../src/spec.ts'
import type {
  CreateCommitIntent,
  SakiControlIntentId,
  SakiExecutionDispatchId,
  SakiGrantId,
  SakiGitOperationIntent,
  SakiInstallationId,
  SakiPrincipalId,
  SakiResourceBindingId,
  SakiStorageGenerationId,
  StageFilesIntent,
  UnstageFilesIntent,
} from '../src/types.ts'

const PROJECT = SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace.project
const PROJECT_ID = PROJECT.id
const AGENT_PROFILE_ID = 'agent-profile-00000000-0000-4000-8000-000000000015' as const
const BINDING_ID = PROJECT.binding.id
const HOST_ID = PROJECT.binding.hostId
const OTHER_HOST_ID = 'host-00000000-0000-4000-8000-000000000099' as typeof HOST_ID
const WORKSPACE_ID = SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace.currentSelection.workspaceId!
const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000011' as SakiInstallationId
const STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000012' as SakiStorageGenerationId
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000013' as SakiPrincipalId
const GRANT_ID = 'grant-00000000-0000-4000-8000-000000000014' as SakiGrantId
const TRUSTED = {
  canonicalWorktreePath: '/fixture/repository',
  canonicalGitDirectory: '/fixture/repository/.git',
  canonicalCommonGitDirectory: '/fixture/repository/.git',
  gitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
  commonGitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
  comparison: { fileMode: true, symlinks: true, autocrlf: false },
} as const

class MemoryTable<K extends string, V> implements KvTable<K, V> {
  readonly records = new Map<K, V>()
  failBeforeCommit: 'put' | 'update' | undefined
  failAfterCommit: 'put' | 'update' | undefined

  constructor(entries: readonly (readonly [K, V])[] = []) {
    for (const [key, value] of entries) this.records.set(key, value)
  }

  get size(): number { return this.records.size }
  get(key: K): V | undefined { return this.records.get(key) }
  entries(): IterableIterator<[K, V]> { return new Map(this.records).entries() }
  keys(): IterableIterator<K> { return new Map(this.records).keys() }

  async put(key: K, value: V): Promise<void> {
    if (this.failBeforeCommit === 'put') {
      this.failBeforeCommit = undefined
      throw new Error('injected put failure')
    }
    this.records.set(key, value)
    if (this.failAfterCommit === 'put') {
      this.failAfterCommit = undefined
      throw new Error('injected put acknowledgement loss')
    }
  }

  async delete(key: K): Promise<boolean> { return this.records.delete(key) }

  async update(key: K, fn: (current: V) => V): Promise<V> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error('missing-key')
    if (this.failBeforeCommit === 'update') {
      this.failBeforeCommit = undefined
      throw new Error('injected update failure')
    }
    const next = fn(current)
    this.records.set(key, next)
    if (this.failAfterCommit === 'update') {
      this.failAfterCommit = undefined
      throw new Error('injected update acknowledgement loss')
    }
    return next
  }
}

class TestAcceptance extends HostOperationAcceptance {
  constructor(readonly operationId: string) { super() }
}

interface FakeOperation {
  readonly request: HostOperationRequest<'stage-files' | 'unstage-files' | 'commit'>
  admission: HostOperationAdmissionSource
  readonly preparation: HostOperationPreparation
  readonly acceptance: HostOperationAcceptance
  snapshot: HostOperationSnapshot
}

class FakeExecution extends SakiHostExecution {
  readonly operations = new Map<string, FakeOperation>()
  readonly listeners = new Set<(change: HostOperationChange) => void>()
  inspectResult: InspectProjectResult
  prepareCount = 0
  inspectCount = 0
  startCount = 0
  readonly startedIntentIds: SakiControlIntentId[] = []
  cancelCount = 0
  beforePrepare: (() => Promise<void>) | undefined
  afterPrepare: (() => void) | undefined
  beforeAdmission: (() => void) | undefined
  afterAdmission: (() => void) | undefined
  admissionExpectation: ((value: HostOperationAdmissionExpectation) => HostOperationAdmissionExpectation) | undefined
  prepareReceiptSnapshot: ((value: HostOperationSnapshot) => HostOperationSnapshot) | undefined
  probeAdmissionDuringPrepare = false
  prepareAdmissionDecision: 'accepted' | 'denied' | 'unavailable' | undefined
  prepareMode: 'success' | 'source-conflict' | 'unavailable' = 'success'
  cancelMode: 'terminal' | 'nonterminal' = 'terminal'
  startMode:
    | 'succeed'
    | 'fail'
    | 'cancel'
    | 'unavailable'
    | 'busy-then-succeed-notification'
    | 'reconciliation'
    | 'throw-after-planning'
    | 'throw-after-publishing'
    | 'throw-after-success' = 'succeed'

  constructor(result: InspectProjectResult) {
    super(new Context())
    this.inspectResult = result
  }

  async inspectProjectSelection(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
    return { ok: false, reason: 'unavailable' }
  }

  async inspectProjectCommit(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
    return { ok: false, reason: 'unavailable' }
  }

  async inspectProject(): Promise<InspectProjectResult> { return this.inspectResult }
  async inspectInterventionOpening(): Promise<InterventionOpeningEvidence> {
    return { kind: 'absent' }
  }
  async readDiff(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
    return { ok: false, reason: 'unavailable' }
  }

  async resumeAgentRun(): Promise<never> { throw new Error('Git-only test Host cannot resume Agent Runs') }

  async prepareOperation<K extends HostOperationKind>(
    request: HostOperationRequest<K>,
    admission: HostOperationAdmissionSource,
  ): Promise<HostOperationReceipt<K>> {
    this.prepareCount += 1
    await this.beforePrepare?.()
    if (this.prepareMode !== 'success') return {
      ok: false,
      reason: this.prepareMode,
    }
    if (request.type === 'start-agent-run' || request.type === 'push-branch') {
      return { ok: false, reason: 'source-conflict' }
    }
    const gitRequest: HostOperationRequest<'stage-files' | 'unstage-files' | 'commit'> = request
    const existing = [...this.operations.values()].find(candidate =>
      candidate.request.source.intentId === gitRequest.source.intentId)
    if (existing !== undefined) {
      existing.admission = admission
      return {
        ok: true,
        preparation: existing.preparation,
        snapshot: existing.snapshot,
        acceptance: existing.acceptance,
      } as HostOperationReceipt<K>
    }
    const operation = {
      id: `host-operation-${String(gitRequest.source.intentId).slice('intent-'.length)}`,
      hostId: gitRequest.expected.binding.hostId,
      type: gitRequest.type,
    } as HostOperationReference<K>
    const preparation = {
      operation,
      preparationRevision: 0,
      requestFingerprint: {
        version: 1 as const,
        digest: canonicalDigest('saki/test-host-request/v1', gitRequest),
      },
    }
    const snapshot = {
      operation,
      revision: 0,
      source: gitRequest.source,
      requestFingerprint: preparation.requestFingerprint,
      bindingId: gitRequest.expected.binding.id,
      bindingRevision: gitRequest.expected.binding.revision,
      preparedAt: 10,
      updatedAt: 10,
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    } as HostOperationSnapshot<K>
    const stored: FakeOperation = {
      request: gitRequest,
      admission,
      preparation,
      acceptance: new TestAcceptance(operation.id),
      snapshot,
    }
    this.operations.set(operation.id, stored)
    this.afterPrepare?.()
    if (this.probeAdmissionDuringPrepare) {
      const decision = await admission({
        bindingId: gitRequest.expected.binding.id,
        bindingRevision: gitRequest.expected.binding.revision,
        preparation,
        source: gitRequest.source,
      }, new AbortController().signal)
      this.prepareAdmissionDecision = decision.kind
    }
    return {
      ok: true,
      preparation,
      snapshot: (this.prepareReceiptSnapshot?.(snapshot) ?? snapshot) as HostOperationSnapshot<K>,
      acceptance: stored.acceptance,
    }
  }

  async startOperation<K extends HostOperationKind>(
    operation: HostOperationReference<K>,
    acceptance: HostOperationAcceptance,
    signal: AbortSignal,
  ): Promise<HostOperationStartResult<K>> {
    this.startCount += 1
    const stored = this.required(operation)
    this.startedIntentIds.push(stored.request.source.intentId)
    if (stored.acceptance !== acceptance) {
      return { ok: false, reason: 'acceptance-mismatch', snapshot: stored.snapshot as HostOperationSnapshot<K> }
    }
    this.beforeAdmission?.()
    const expectation = {
      bindingId: stored.request.expected.binding.id,
      bindingRevision: stored.request.expected.binding.revision,
      preparation: stored.preparation,
      source: stored.request.source,
    }
    const decision = await stored.admission(
      this.admissionExpectation?.(expectation) ?? expectation,
      signal,
    )
    this.afterAdmission?.()
    if (decision.kind !== 'accepted') {
      return {
        ok: false,
        reason: decision.kind === 'unavailable' ? 'unavailable' : decision.reason,
        snapshot: stored.snapshot as HostOperationSnapshot<K>,
      }
    }
    if (this.startMode === 'throw-after-planning' || this.startMode === 'throw-after-publishing') {
      stored.snapshot = this.snapshot(stored, {
        state: 'planning',
        admission: { kind: 'accepted', revision: decision.admissionRevision, acceptedAt: 11 },
        plannedAt: 12,
      })
      if (this.startMode === 'throw-after-publishing') {
        stored.snapshot = this.snapshot(stored, {
          state: 'publishing',
          admission: stored.snapshot.admission,
          plannedAt: 12,
          effectPlannedAt: 13,
          publishingAt: 13,
          updatedAt: 13,
        })
      }
      throw new Error(`injected ${this.startMode.slice('throw-after-'.length)} acknowledgement loss`)
    }
    if (this.startMode === 'busy-then-succeed-notification') {
      const planning = this.snapshot(stored, {
        state: 'planning',
        admission: { kind: 'accepted', revision: decision.admissionRevision, acceptedAt: 11 },
        plannedAt: 12,
      })
      stored.snapshot = this.success(stored, decision.admissionRevision, 2)
      this.emit(stored.snapshot)
      return { ok: false, reason: 'busy', snapshot: planning as HostOperationSnapshot<K> }
    }
    if (this.startMode === 'reconciliation') {
      stored.snapshot = this.snapshot(stored, {
        state: 'reconciliation-required',
        admission: { kind: 'accepted', revision: decision.admissionRevision, acceptedAt: 11 },
        observedAt: 12,
        reason: 'effect-unknown',
      })
      this.emit(stored.snapshot)
      return { ok: true, snapshot: stored.snapshot as HostOperationSnapshot<K> }
    }
    if (this.startMode === 'fail') {
      stored.snapshot = this.snapshot(stored, {
        state: 'failed',
        admission: { kind: 'accepted', revision: decision.admissionRevision, acceptedAt: 11 },
        completedAt: 12,
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      })
      return { ok: true, snapshot: stored.snapshot as HostOperationSnapshot<K> }
    }
    if (this.startMode === 'cancel') {
      stored.snapshot = this.snapshot(stored, {
        state: 'canceled',
        admission: { kind: 'accepted', revision: decision.admissionRevision, acceptedAt: 11 },
        completedAt: 12,
        reason: 'source-canceled',
        effect: 'none',
      })
      return { ok: true, snapshot: stored.snapshot as HostOperationSnapshot<K> }
    }
    if (this.startMode === 'unavailable') {
      return { ok: false, reason: 'unavailable', snapshot: stored.snapshot as HostOperationSnapshot<K> }
    }
    stored.snapshot = this.success(stored, decision.admissionRevision, 1)
    this.emit(stored.snapshot)
    if (this.startMode === 'throw-after-success') throw new Error('injected start acknowledgement loss')
    return { ok: true, snapshot: stored.snapshot as HostOperationSnapshot<K> }
  }

  async inspectOperation<K extends HostOperationKind>(
    operation: HostOperationReference<K>,
  ): Promise<HostOperationSnapshot<K>> {
    this.inspectCount += 1
    return this.required(operation).snapshot as HostOperationSnapshot<K>
  }

  async cancelOperation<K extends HostOperationKind>(
    operation: HostOperationReference<K>,
    reason: HostOperationCancellationReason,
  ): Promise<HostOperationSnapshot<K>> {
    this.cancelCount += 1
    const stored = this.required(operation)
    if (this.cancelMode === 'nonterminal') return stored.snapshot as HostOperationSnapshot<K>
    stored.snapshot = this.snapshot(stored, {
      state: 'canceled',
      admission: stored.snapshot.admission,
      completedAt: 12,
      reason,
      effect: 'none',
    })
    this.emit(stored.snapshot)
    return stored.snapshot as HostOperationSnapshot<K>
  }

  onChanged(listener: (change: HostOperationChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private required(operation: HostOperationReference): FakeOperation {
    const stored = this.operations.get(operation.id)
    if (stored === undefined) throw new Error('test Host Operation is absent')
    return stored
  }

  snapshot(stored: FakeOperation, state: object): HostOperationSnapshot {
    return {
      operation: stored.preparation.operation,
      revision: stored.snapshot.revision + 1,
      source: stored.request.source,
      requestFingerprint: stored.preparation.requestFingerprint,
      bindingId: stored.request.expected.binding.id,
      bindingRevision: stored.request.expected.binding.revision,
      preparedAt: stored.snapshot.preparedAt,
      updatedAt: 12,
      ...state,
    } as HostOperationSnapshot
  }

  private success(stored: FakeOperation, admissionRevision: number, revision: number): HostOperationSnapshot {
    const result = stored.request.type === 'commit'
      ? {
        type: 'commit' as const,
        commitId: '9'.repeat(40),
        treeId: 'a'.repeat(40),
        parent: { kind: 'commit' as const, objectId: '1'.repeat(40) },
        target: { kind: 'symbolic-ref' as const, ref: 'refs/heads/main' },
        author: { name: 'Test', email: 'test@example.com', timestamp: 1, timezone: '+0000', source: 'git-config' as const },
        committer: { name: 'Test', email: 'test@example.com', timestamp: 1, timezone: '+0000', source: 'git-config' as const },
      }
      : {
        type: stored.request.type,
        changes: stored.request.changes.map((change, index) => ({ ...change, path: `selected-${index}.txt` })),
        resultingIndex: stored.request.expected.index,
      }
    return {
      operation: stored.preparation.operation,
      revision,
      source: stored.request.source,
      requestFingerprint: stored.preparation.requestFingerprint,
      bindingId: stored.request.expected.binding.id,
      bindingRevision: stored.request.expected.binding.revision,
      preparedAt: 10,
      updatedAt: 13,
      state: 'succeeded',
      admission: { kind: 'accepted', revision: admissionRevision, acceptedAt: 11 },
      completedAt: 13,
      result,
    } as HostOperationSnapshot
  }

  private emit(snapshot: HostOperationSnapshot): void {
    for (const listener of this.listeners) {
      listener({ operation: snapshot.operation, revision: snapshot.revision })
    }
  }
}

interface Harness {
  readonly operations: GitOperations
  readonly intents: MemoryTable<SakiControlIntentId, GitOperationIntentRecord>
  readonly admissions: MemoryTable<SakiResourceBindingId, BindingWriteAdmissionRecord>
  readonly execution: FakeExecution
  readonly registry: DevelopmentProjectRegistryRecord
  authority: boolean
  bindingCurrent: boolean
  currentBinding: ReturnType<typeof statusFixture>['resolved']
}

function harness(inspectResult: InspectProjectResult = statusFixture().result): Harness {
  const fixture = statusFixture()
  const intents = new MemoryTable<SakiControlIntentId, GitOperationIntentRecord>()
  const admissions = new MemoryTable<SakiResourceBindingId, BindingWriteAdmissionRecord>([[
    BINDING_ID,
    bindingWriteAdmissionRecordSchema.parse({
      id: BINDING_ID, schemaVersion: 1, revision: 0, state: 'available', updatedAt: 1,
    }),
  ]])
  const state = { authority: true, bindingCurrent: true, currentBinding: fixture.resolved }
  const execution = new FakeExecution(inspectResult)
  const operations = new GitOperations({
    intentTable: intents,
    admissionTable: admissions,
    execution,
    projects: {
      activeBinding: (projectId: string, registryRevision: number) =>
        projectId === PROJECT_ID && registryRevision === fixture.registry.revision
          ? fixture.resolved : 'stale',
      currentActiveBinding: (projectId: string) => projectId === PROJECT_ID && state.bindingCurrent
        ? state.currentBinding
        : 'not-found',
    } as never,
    authorityCurrent: () => state.authority,
    validateActorReference: () => {},
    notifyChanged: () => {},
    lifetime: new AbortController().signal,
  })
  return {
    operations,
    intents,
    admissions,
    execution,
    registry: fixture.registry,
    get authority() { return state.authority },
    set authority(value: boolean) { state.authority = value },
    get bindingCurrent() { return state.bindingCurrent },
    set bindingCurrent(value: boolean) { state.bindingCurrent = value },
    get currentBinding() { return state.currentBinding },
    set currentBinding(value: ReturnType<typeof statusFixture>['resolved']) { state.currentBinding = value },
  }
}

function statusFixture() {
  const registration = {
    projection: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection,
    trusted: TRUSTED,
  }
  const current = {
    projection: SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace.currentSelection,
    trusted: TRUSTED,
  }
  const baseline = SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.baseline
  const resource = resourceBindingRecordSchema.parse({
    id: BINDING_ID,
    revision: 0,
    projectId: PROJECT_ID,
    hostId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    health: 'active',
    registrationInspection: registration,
    currentInspection: current,
    inheritedChangeBaseline: baseline,
    createdAt: 1,
    observedAt: 1,
  })
  const registry = developmentProjectRegistryRecordSchema.parse({
    id: 'development-project-registry',
    schemaVersion: 2,
    revision: 1,
    projects: [{
      id: PROJECT_ID,
      revision: 0,
      projectTitle: 'Fixture project',
      resourceBindingId: BINDING_ID,
      defaultAgentProfileId: AGENT_PROFILE_ID,
      state: 'active',
      createdAt: 1,
    }],
    agentProfiles: [{
      id: AGENT_PROFILE_ID,
      projectId: PROJECT_ID,
      version: 1,
      agentPresetId: 'standard',
      modelRouteRequest: null,
      createdAt: 1,
    }],
    resourceBindings: [resource],
    canonicalWorktreeIndex: [{ hostId: HOST_ID, path: TRUSTED.canonicalWorktreePath, resourceBindingId: BINDING_ID }],
    gitDirectoryIndex: [{ hostId: HOST_ID, path: TRUSTED.canonicalGitDirectory, resourceBindingId: BINDING_ID }],
    intentMappings: [{
      intentId: 'intent-00000000-0000-4000-8000-000000000099',
      projectId: PROJECT_ID,
      resourceBindingId: BINDING_ID,
      registryRevision: 1,
    }],
  })
  const binding = {
    id: BINDING_ID,
    revision: 0,
    health: 'active' as const,
    hostId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    expectedInspection: registration,
    inheritedChangeBaseline: baseline,
  }
  const changeMaterial = {
    path: 'tracked.txt',
    kind: 'ordinary' as const,
    indexStatus: 'modified' as const,
    worktreeStatus: 'modified' as const,
    submodule: { kind: 'not-submodule' as const },
    head: { mode: '100644' as const, objectId: '1'.repeat(40) },
    index: { mode: '100644' as const, objectId: '2'.repeat(40) },
    worktreeMode: '100644' as const,
    worktreeEvidence: {
      kind: 'regular' as const, mode: '100644' as const, byteLength: 7, contentDigest: '3'.repeat(64),
    },
    attribution: 'not-inherited' as const,
  } satisfies ProjectGitChangeFingerprintMaterial
  const change = { ...changeMaterial, fingerprint: computeProjectGitChangeFingerprint(changeMaterial) }
  const seed = {
    observationVersion: 1,
    bindingId: BINDING_ID,
    bindingRevision: 0,
    bindingHealth: 'active',
    locked: false,
    objectFormat: 'sha1',
    head: { kind: 'commit', objectId: '1'.repeat(40), symbolicRef: 'refs/heads/main' },
    branch: { kind: 'attached', ref: 'refs/heads/main', name: 'main' },
    index: { kind: 'tree', treeId: '5'.repeat(40) },
    worktree: { version: 1, digest: '6'.repeat(64) },
    changes: [change],
    structuredMutation: { available: true, blockers: [] },
  } as const satisfies ProjectGitStatusSeedMaterial
  const seedDigest = computeProjectGitStatusSeedDigest(seed)
  const withId = {
    ...seed,
    changes: seed.changes.map(entry => ({ id: computeProjectGitChangeId(seedDigest, entry), ...entry })),
  }
  const observed = { ...withId, observedAt: 2 }
  const observation: ProjectGitStatusObservation = {
    ...observed,
    fingerprint: computeProjectGitStatusFingerprint(observed),
  }
  return {
    registry,
    resolved: { registryRevision: 1, projectId: PROJECT_ID, projectRevision: 0, binding },
    result: { ok: true, observation, preEffectBaseline: baseline } as InspectProjectResult,
  }
}

function actor(): ControlIntentActor {
  return {
    installationId: INSTALLATION_ID,
    storageGenerationId: STORAGE_GENERATION_ID,
    hostId: HOST_ID,
    principalId: PRINCIPAL_ID,
    principalRevision: 1,
    grantId: GRANT_ID,
    grantRevision: 1,
  }
}

function intent(
  type: 'stage-files' | 'unstage-files' | 'create-commit' = 'stage-files',
  id = 'intent-00000000-0000-4000-8000-000000000021' as SakiControlIntentId,
): SakiGitOperationIntent {
  const fixture = statusFixture()
  if (!fixture.result.ok) throw new Error('test status is unavailable')
  const expected = {
    projectId: PROJECT_ID,
    expectedRegistryRevision: 1,
    expectedProjectRevision: 0,
    expectedBinding: { id: BINDING_ID, revision: 0 },
    expectedStatus: fixture.result.observation.fingerprint,
    expectedHead: fixture.result.observation.head,
    expectedIndex: fixture.result.observation.index as Extract<typeof fixture.result.observation.index, { kind: 'tree' }>,
    expectedWorktree: fixture.result.observation.worktree,
  }
  if (type === 'create-commit') return { type, intentId: id, expected, message: 'subject' }
  return {
    type,
    intentId: id,
    expected,
    changes: fixture.result.observation.changes.map(change => ({ id: change.id, fingerprint: change.fingerprint })),
  }
}

async function stopAfterPhase(
  test: Harness,
  submitted: SakiGitOperationIntent,
  phase: 'admission-reserved' | 'host-prepared' | 'accepted',
): Promise<GitOperationIntentRecord> {
  const controller = new AbortController()
  const update = test.intents.update.bind(test.intents)
  test.intents.update = async (key, operation) => {
    const next = await update(key, operation)
    if (next.phase === phase) controller.abort(new Error(`stopped after ${phase}`))
    return next
  }
  try {
    await expect(test.operations.submit(submitted, actor(), controller.signal))
      .rejects.toThrow(`stopped after ${phase}`)
  } finally {
    test.intents.update = update
  }
  return gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
}

function requiredFakeOperation(test: Harness): FakeOperation {
  const operation = test.execution.operations.values().next().value
  if (operation === undefined) throw new Error('test Host Operation is absent')
  return operation
}

function availableAdmission(revision = 0): BindingWriteAdmissionRecord {
  return bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision,
    state: 'available',
    updatedAt: 1,
  })
}

function agentRunAdmission(revision = 1): Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run' }> {
  const admission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision,
    state: 'agent-run',
    phase: 'reserved',
    bindingRevision: 0,
    originIntentId: 'intent-00000000-0000-4000-8000-000000000390',
    agentRunId: 'agent-run-00000000-0000-4000-8000-000000000391',
    payloadDigest: '3'.repeat(64),
    reservedAt: 1,
    updatedAt: 1,
  })
  if (admission.state !== 'agent-run') throw new Error('test admission is not owned by an Agent Run')
  return admission
}

function retainedAcceptedAdmission(
  record: GitOperationIntentRecord,
  revision = 10,
): Extract<BindingWriteAdmissionRecord, { readonly state: 'manual-host-operation'; readonly phase: 'accepted' }> {
  if (record.hostRequest === undefined || record.preparation === undefined) {
    throw new Error('terminal admission fixture has no Host evidence')
  }
  return bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision,
    state: 'manual-host-operation',
    phase: 'accepted',
    bindingRevision: record.hostRequest.expected.binding.revision,
    source: record.hostRequest.source,
    action: 'project-changes:stage',
    reservedAt: 1,
    preparation: record.preparation,
    acceptedAt: 2,
    updatedAt: 2,
  }) as Extract<BindingWriteAdmissionRecord, {
    readonly state: 'manual-host-operation'
    readonly phase: 'accepted'
  }>
}

describe('Saki structured Git operations', () => {
  it('preserves an Agent Run write owner during validation and Git reservation', async () => {
    const test = harness()
    const admission = agentRunAdmission()
    test.admissions.records.set(BINDING_ID, admission)

    expect(() => validateGitOperationsDurableState(
      test.intents,
      test.admissions,
      test.registry,
      new Set(),
      new Set(),
      () => {},
    )).not.toThrow()
    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000392' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: false, reason: 'unavailable' })
    expect(test.admissions.get(BINDING_ID)).toEqual(admission)
    expect(test.execution.prepareCount).toBe(0)
  })

  it('leaves Branch Push admissions to Branch Delivery validation', () => {
    const test = harness()
    test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
      id: BINDING_ID,
      schemaVersion: 1,
      revision: 1,
      state: 'manual-host-operation',
      phase: 'reserved',
      bindingRevision: 0,
      source: {
        kind: 'control-intent',
        intentId: 'intent-00000000-0000-4000-8000-000000000393',
        intentRevision: 0,
        payloadDigest: '3'.repeat(64),
      },
      action: 'project-branch:push',
      reservedAt: 1,
      updatedAt: 1,
    }))

    expect(validateGitOperationsDurableState(
      test.intents,
      test.admissions,
      test.registry,
      new Set(),
      new Set(),
      () => {},
    )).toEqual({ intents: [] })
  })

  it('keeps all three browser Intents strict, path-free, and selection-bounded', () => {
    const stage = intent('stage-files') as StageFilesIntent
    const unstage = intent('unstage-files') as UnstageFilesIntent
    const commit = intent('create-commit') as CreateCommitIntent
    expect(stageFilesIntentSchema.parse(stage)).toEqual(stage)
    expect(unstageFilesIntentSchema.parse(unstage)).toEqual(unstage)
    expect(createCommitIntentSchema.parse(commit)).toEqual(commit)
    expect(stageFilesIntentSchema.safeParse({ ...stage, path: 'tracked.txt' }).success).toBe(false)
    expect(stageFilesIntentSchema.safeParse({ ...stage, changes: [] }).success).toBe(false)
    expect(stageFilesIntentSchema.safeParse({ ...stage, changes: [stage.changes[0], stage.changes[0]] }).success)
      .toBe(false)
    expect(createCommitIntentSchema.safeParse({ ...commit, message: '' }).success).toBe(false)
    expect(createCommitIntentSchema.safeParse({ ...commit, message: 'bad\uD800message' }).success).toBe(false)
    expect(createCommitIntentSchema.safeParse({ ...commit, message: 'bad\uD800' }).success).toBe(false)
    expect(createCommitIntentSchema.safeParse({ ...commit, message: '\uDC00bad' }).success).toBe(false)
  })

  it('rejects an unknown Git operation Intent discriminant before doing work', async () => {
    const test = harness()
    // A forged tag exercises the runtime backstop; a real union extension must also satisfy assertNever at compile time.
    const submitted = { ...intent('stage-files'), type: 'future-operation' } as unknown as SakiGitOperationIntent

    await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
      .rejects.toThrow('unexpected Saki Git operation discriminant: "future-operation"')
    expect(test.intents.size).toBe(0)
    expect(test.execution.prepareCount).toBe(0)
  })

  it('keeps index operations available while detached HEAD disables CreateCommit', () => {
    const fixture = statusFixture()
    if (!fixture.result.ok || fixture.result.observation.head.kind !== 'commit') {
      throw new Error('test status has no committed HEAD')
    }
    const { fingerprint: _fingerprint, upstream: _upstream, ...attached } = fixture.result.observation
    const detached = {
      ...attached,
      head: { kind: 'commit' as const, objectId: fixture.result.observation.head.objectId },
      branch: { kind: 'detached' as const },
    }
    const result: InspectProjectResult = {
      ...fixture.result,
      observation: { ...detached, fingerprint: computeProjectGitStatusFingerprint(detached) },
    }
    const test = harness(result)

    expect(test.operations.project(BINDING_ID, result, {
      'project-changes:stage': true,
      'project-changes:unstage': true,
      'project-commit:create': true,
    })).toMatchObject({
      stageFiles: { available: true, reasons: [] },
      unstageFiles: { available: true, reasons: [] },
      createCommit: { available: false, reasons: ['detached-head'] },
    })
  })

  it('projects unavailable status, authorization, corrupt admission, and orphaned ownership fail closed', async () => {
    const test = harness()
    const denied = test.operations.project(BINDING_ID, { ok: false, reason: 'unavailable' }, {
      'project-changes:stage': false,
      'project-changes:unstage': false,
      'project-commit:create': false,
    })
    expect(denied.stageFiles).toEqual({
      available: false,
      reasons: ['status-unavailable', 'action-denied'],
    })

    test.admissions.records.delete(BINDING_ID)
    expect(test.operations.project(BINDING_ID, statusFixture().result, {
      'project-changes:stage': true,
      'project-changes:unstage': true,
      'project-commit:create': true,
    }).stageFiles.reasons).toEqual(['write-admission-unavailable'])

    test.admissions.records.set(BINDING_ID, { hostile: true } as never)
    expect(test.operations.project(BINDING_ID, statusFixture().result, {
      'project-changes:stage': true,
      'project-changes:unstage': true,
      'project-commit:create': true,
    }).stageFiles.reasons).toEqual(['write-admission-unavailable'])

    const owned = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000219' as SakiControlIntentId,
    )
    await stopAfterPhase(owned, submitted, 'admission-reserved')
    owned.intents.records.delete(submitted.intentId)
    expect(owned.operations.project(BINDING_ID, statusFixture().result, {
      'project-changes:stage': true,
      'project-changes:unstage': true,
      'project-commit:create': true,
    })).not.toHaveProperty('current')
    owned.intents.records.set(submitted.intentId, { hostile: true } as never)
    expect(owned.operations.project(BINDING_ID, statusFixture().result, {
      'project-changes:stage': true,
      'project-changes:unstage': true,
      'project-commit:create': true,
    })).not.toHaveProperty('current')
  })

  it('disables and rejects CreateCommit when no ordinary change is staged', async () => {
    const fixture = statusFixture()
    if (!fixture.result.ok) throw new Error('test status is unavailable')
    const { fingerprint: _fingerprint, changes: _changes, ...observed } = fixture.result.observation
    const cleanSeed = { ...observed, changes: [] }
    const observation: ProjectGitStatusObservation = {
      ...cleanSeed,
      fingerprint: computeProjectGitStatusFingerprint(cleanSeed),
    }
    const result: InspectProjectResult = { ...fixture.result, observation }
    const test = harness(result)

    expect(test.operations.project(BINDING_ID, result, {
      'project-changes:stage': true,
      'project-changes:unstage': true,
      'project-commit:create': true,
    })).toMatchObject({
      stageFiles: { available: true, reasons: [] },
      unstageFiles: { available: true, reasons: [] },
      createCommit: { available: false, reasons: ['no-staged-changes'] },
    })

    const submitted = intent('create-commit') as CreateCommitIntent
    const cleanIntent: CreateCommitIntent = {
      ...submitted,
      expected: { ...submitted.expected, expectedStatus: observation.fingerprint },
    }
    await expect(test.operations.submit(cleanIntent, actor(), new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(test.execution.prepareCount).toBe(0)
    expect(test.intents.size).toBe(0)
  })

  it('rejects a detached CreateCommit before persisting or preparing Host work', async () => {
    const fixture = statusFixture()
    if (!fixture.result.ok || fixture.result.observation.head.kind !== 'commit') {
      throw new Error('test status has no committed HEAD')
    }
    const { fingerprint: _fingerprint, upstream: _upstream, ...attached } = fixture.result.observation
    const detached = {
      ...attached,
      head: { kind: 'commit' as const, objectId: fixture.result.observation.head.objectId },
      branch: { kind: 'detached' as const },
    }
    const observation = { ...detached, fingerprint: computeProjectGitStatusFingerprint(detached) }
    const result: InspectProjectResult = { ...fixture.result, observation }
    const test = harness(result)
    const submitted = intent('create-commit') as CreateCommitIntent
    const detachedIntent: CreateCommitIntent = {
      ...submitted,
      expected: {
        ...submitted.expected,
        expectedStatus: observation.fingerprint,
        expectedHead: observation.head,
      },
    }

    await expect(test.operations.submit(detachedIntent, actor(), new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(test.intents.size).toBe(0)
    expect(test.execution.prepareCount).toBe(0)
  })

  it('persists exact evidence, fences the Host effect, releases admission, and replays one success', async () => {
    const test = harness()
    const submitted = intent('stage-files')
    const result = await test.operations.submit(submitted, actor(), new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Git operation did not succeed')
    expect(result.receipt).toMatchObject({ state: 'succeeded', type: 'stage-files', projectId: PROJECT_ID })
    expect(result.receipt.operation).not.toHaveProperty('hostId')
    expect(result.receipt.result).toMatchObject({ type: 'stage-files', changes: [{ path: 'selected-0.txt' }] })
    const durable = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    expect(durable).toMatchObject({ phase: 'succeeded', requestRevision: 0 })
    expect(durable.hostRequest?.source.intentRevision).toBe(0)
    expect(durable.revision).toBeGreaterThan(0)
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })

    const replay = await test.operations.submit(submitted, actor(), new AbortController().signal)
    expect(replay).toEqual(result)
    expect(test.execution.startCount).toBe(1)
    const changed = await test.operations.submit({ ...submitted, changes: [] } as StageFilesIntent, actor(), new AbortController().signal)
    expect(changed).toEqual({ ok: false, reason: 'conflict' })
  })

  it.each([
    ['unstage-files', 'intent-00000000-0000-4000-8000-000000000201'],
    ['create-commit', 'intent-00000000-0000-4000-8000-000000000202'],
  ] as const)('projects a successful %s result from its correlated Host kind', async (type, rawId) => {
    const test = harness()
    const submitted = intent(type, rawId as SakiControlIntentId)
    const result = await test.operations.submit(submitted, actor(), new AbortController().signal)

    expect(result).toMatchObject({ ok: true, receipt: { type, state: 'succeeded' } })
    expect(result.ok && result.receipt.operation.type).toBe(type === 'create-commit' ? 'commit' : type)
  })

  it.each([
    ['stage-files', 'fail', 'failure', 'failed', 'intent-00000000-0000-4000-8000-000000000203'],
    ['unstage-files', 'fail', 'failure', 'failed', 'intent-00000000-0000-4000-8000-000000000204'],
    ['create-commit', 'fail', 'failure', 'failed', 'intent-00000000-0000-4000-8000-000000000205'],
    ['stage-files', 'cancel', 'canceled', 'canceled', 'intent-00000000-0000-4000-8000-000000000206'],
    ['unstage-files', 'cancel', 'canceled', 'canceled', 'intent-00000000-0000-4000-8000-000000000207'],
    ['create-commit', 'cancel', 'canceled', 'canceled', 'intent-00000000-0000-4000-8000-000000000208'],
    ['unstage-files', 'reconciliation', 'reconciliation-required', 'reconciliation-required',
      'intent-00000000-0000-4000-8000-000000000209'],
    ['create-commit', 'reconciliation', 'reconciliation-required', 'reconciliation-required',
      'intent-00000000-0000-4000-8000-000000000210'],
  ] as const)(
    'projects a terminal %s Host snapshot in %s mode',
    async (type, mode, reason, state, rawId) => {
      const test = harness()
      test.execution.startMode = mode
      const result = await test.operations.submit(
        intent(type, rawId as SakiControlIntentId),
        actor(),
        new AbortController().signal,
      )

      expect(result).toMatchObject({ ok: false, reason, receipt: { type, state } })
      if (state === 'reconciliation-required') {
        expect(test.operations.project(BINDING_ID, statusFixture().result, {
          'project-changes:stage': true,
          'project-changes:unstage': true,
          'project-commit:create': true,
        })).toMatchObject({ current: { type, state } })
      }
    },
  )

  it.each([
    ['stage-files', 'intent-00000000-0000-4000-8000-000000000211'],
    ['unstage-files', 'intent-00000000-0000-4000-8000-000000000212'],
    ['create-commit', 'intent-00000000-0000-4000-8000-000000000213'],
  ] as const)('projects %s while Host-prepared admission is temporarily unavailable', async (type, rawId) => {
    const test = harness()
    const submitted = intent(type, rawId as SakiControlIntentId)
    await stopAfterPhase(test, submitted, 'host-prepared')

    expect(test.operations.project(BINDING_ID, statusFixture().result, {
      'project-changes:stage': true,
      'project-changes:unstage': true,
      'project-commit:create': true,
    })).toMatchObject({ current: { type, state: 'host-prepared' } })

    const current = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(BINDING_ID))
    test.admissions.records.set(BINDING_ID, availableAdmission(current.revision + 1))
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { type, state: 'host-prepared' },
    })
  })

  it('projects admission-reserved, accepted, and reconciliation ownership without exposing Host authority', async () => {
    const allowed = {
      'project-changes:stage': true,
      'project-changes:unstage': true,
      'project-commit:create': true,
    } as const
    const reserved = harness()
    const reservedIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000214' as SakiControlIntentId,
    )
    await stopAfterPhase(reserved, reservedIntent, 'admission-reserved')
    expect(reserved.operations.project(BINDING_ID, statusFixture().result, allowed))
      .toMatchObject({ current: { type: 'stage-files', state: 'admission-reserved' } })

    for (const [state, rawId] of [
      ['accepted', 'intent-00000000-0000-4000-8000-000000000215'],
      ['planning', 'intent-00000000-0000-4000-8000-000000000216'],
      ['publishing', 'intent-00000000-0000-4000-8000-000000000217'],
    ] as const) {
      const test = harness()
      const submitted = intent('stage-files', rawId as SakiControlIntentId)
      const record = await stopAfterPhase(test, submitted, 'accepted')
      const operation = requiredFakeOperation(test)
      const acceptedAt = 11
      const operationSnapshot = state === 'accepted'
        ? test.execution.snapshot(operation, {
          state,
          admission: { kind: 'accepted', revision: record.admissionRevision, acceptedAt },
          updatedAt: acceptedAt,
        })
        : state === 'planning'
          ? test.execution.snapshot(operation, {
            state,
            admission: { kind: 'accepted', revision: record.admissionRevision, acceptedAt },
            plannedAt: 12,
          })
          : test.execution.snapshot(operation, {
            state,
            admission: { kind: 'accepted', revision: record.admissionRevision, acceptedAt },
            plannedAt: 12,
            effectPlannedAt: 12,
            publishingAt: 12,
          })
      test.intents.records.set(record.id, gitOperationIntentRecordSchema.parse({ ...record, operationSnapshot }))
      expect(test.operations.project(BINDING_ID, statusFixture().result, allowed))
        .toMatchObject({ current: { type: 'stage-files', state: 'accepted', operation: { state } } })
    }

    const reconciling = harness()
    reconciling.execution.startMode = 'reconciliation'
    await reconciling.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000218' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )
    expect(reconciling.operations.project(BINDING_ID, statusFixture().result, allowed))
      .toMatchObject({ current: { type: 'stage-files', state: 'reconciliation-required' } })
  })

  it('rejects durable producer reason, state, and operation-kind mismatches before projection', async () => {
    const test = harness()
    const submitted = intent('stage-files')
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true })
    const record = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    const snapshot = record.operationSnapshot
    if (snapshot?.state !== 'succeeded' || snapshot.operation.type !== 'stage-files'
      || snapshot.result.type !== 'stage-files') {
      throw new Error('test Git operation did not retain StageFiles success evidence')
    }
    const { result: _result, ...snapshotWithoutResult } = snapshot

    expect(gitOperationIntentRecordSchema.safeParse({
      ...record,
      phase: 'failed',
      terminalReason: 'binding-stale',
      operationSnapshot: {
        ...snapshotWithoutResult,
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    }).success).toBe(false)
    expect(gitOperationIntentRecordSchema.safeParse({ ...record, phase: 'accepted' }).success).toBe(false)
    expect(gitOperationIntentRecordSchema.safeParse({
      ...record,
      operationSnapshot: {
        ...snapshot,
        operation: { ...snapshot.operation, type: 'unstage-files' },
        result: { ...snapshot.result, type: 'unstage-files' },
      },
    }).success).toBe(false)
    void _result
  })

  it('durably distinguishes expected-evidence and invalid-selection conflicts without a Host request', async () => {
    const evidence = harness()
    const stale = intent('stage-files') as StageFilesIntent
    const staleIntent = {
      ...stale,
      expected: { ...stale.expected, expectedBinding: { ...stale.expected.expectedBinding, revision: 1 } },
    }
    const staleResult = await evidence.operations.submit(staleIntent, actor(), new AbortController().signal)
    expect(staleResult).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'expected-evidence' },
    })
    expect(evidence.intents.get(stale.intentId)).toMatchObject({ phase: 'conflict', terminalReason: 'expected-evidence' })
    expect(evidence.intents.get(stale.intentId)).not.toHaveProperty('hostRequest')
    expect(await evidence.operations.submit(staleIntent, actor(), new AbortController().signal)).toEqual(staleResult)

    const selection = harness()
    const selected = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000022' as SakiControlIntentId,
    ) as StageFilesIntent
    const invalid = {
      ...selected,
      changes: [{ ...selected.changes[0]!, fingerprint: { version: 1 as const, digest: 'f'.repeat(64) } }],
    }
    const invalidResult = await selection.operations.submit(invalid, actor(), new AbortController().signal)
    expect(invalidResult).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'invalid-selection' },
    })
    expect(selection.execution.prepareCount).toBe(0)
  })

  it('keeps a fresh unavailable baseline retryable without persisting an Intent', async () => {
    const fixture = statusFixture()
    if (!fixture.result.ok) throw new Error('test status is unavailable')
    const test = harness({
      ...fixture.result,
      preEffectBaseline: {
        kind: 'unavailable',
        reason: 'io-failure',
        observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0, elapsedMs: 0 },
      },
    })
    const submitted = intent('stage-files')
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(test.intents.size).toBe(0)
  })

  it('distinguishes authorization, inspection, evidence, and mutation blockers before Host preparation', async () => {
    const denied = harness()
    denied.authority = false
    await expect(denied.operations.submit(intent('stage-files'), actor(), new AbortController().signal))
      .resolves.toEqual({ ok: false, reason: 'denied' })

    for (const [reason, expected, rawId] of [
      ['unavailable', 'unavailable', 'intent-00000000-0000-4000-8000-000000000220'],
      ['malformed', 'conflict', 'intent-00000000-0000-4000-8000-000000000221'],
    ] as const) {
      const test = harness({ ok: false, reason })
      await expect(test.operations.submit(
        intent('stage-files', rawId as SakiControlIntentId),
        actor(),
        new AbortController().signal,
      )).resolves.toMatchObject({ ok: false, reason: expected })
    }

    const revoked = harness()
    const inspect = revoked.execution.inspectProject.bind(revoked.execution)
    revoked.execution.inspectProject = async (...args) => {
      const result = await inspect(...args)
      revoked.authority = false
      return result
    }
    await expect(revoked.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000222' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toEqual({ ok: false, reason: 'denied' })

    const changed = harness()
    const originalIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000223' as SakiControlIntentId,
    )
    if (!changed.execution.inspectResult.ok) throw new Error('test status is unavailable')
    changed.execution.inspectResult = {
      ...changed.execution.inspectResult,
      observation: {
        ...changed.execution.inspectResult.observation,
        fingerprint: { version: 1, digest: 'f'.repeat(64) },
      },
    }
    await expect(changed.operations.submit(originalIntent, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: false, reason: 'conflict', receipt: { reason: 'expected-evidence' } })

    for (const [blocker, expected, rawId] of [
      ['baseline-unavailable', 'unavailable', 'intent-00000000-0000-4000-8000-000000000224'],
      ['locked', 'conflict', 'intent-00000000-0000-4000-8000-000000000225'],
    ] as const) {
      const fixture = statusFixture()
      if (!fixture.result.ok) throw new Error('test status is unavailable')
      const { fingerprint: _fingerprint, ...seed } = fixture.result.observation
      const blockedSeed = {
        ...seed,
        structuredMutation: { available: false as const, blockers: [blocker] },
      }
      const observation = { ...blockedSeed, fingerprint: computeProjectGitStatusFingerprint(blockedSeed) }
      const test = harness({ ...fixture.result, observation })
      const submitted = intent(
        'stage-files',
        rawId as SakiControlIntentId,
      ) as StageFilesIntent
      await expect(test.operations.submit({
        ...submitted,
        expected: { ...submitted.expected, expectedStatus: observation.fingerprint },
      }, actor(), new AbortController().signal)).resolves.toMatchObject({ ok: false, reason: expected })
    }
  })

  it.each([
    ['registry', (submitted: StageFilesIntent) => ({
      ...submitted,
      expected: { ...submitted.expected, expectedRegistryRevision: submitted.expected.expectedRegistryRevision + 1 },
    })],
    ['project', (submitted: StageFilesIntent) => ({
      ...submitted,
      expected: { ...submitted.expected, expectedProjectRevision: submitted.expected.expectedProjectRevision + 1 },
    })],
    ['binding-id', (submitted: StageFilesIntent) => ({
      ...submitted,
      expected: {
        ...submitted.expected,
        expectedBinding: {
          ...submitted.expected.expectedBinding,
          id: 'binding-00000000-0000-4000-8000-000000000299' as SakiResourceBindingId,
        },
      },
    })],
    ['binding-revision', (submitted: StageFilesIntent) => ({
      ...submitted,
      expected: {
        ...submitted.expected,
        expectedBinding: { ...submitted.expected.expectedBinding, revision: 1 },
      },
    })],
  ] as const)('persists an expected-evidence conflict for stale %s authority', async (_name, mutate) => {
    const test = harness()
    const submitted = mutate(intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000226' as SakiControlIntentId,
    ) as StageFilesIntent)
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { reason: 'expected-evidence' },
    })
  })

  it.each([
    ['unavailable', 'unavailable', 'intent-00000000-0000-4000-8000-000000000227'],
    ['source-conflict', 'conflict', 'intent-00000000-0000-4000-8000-000000000228'],
  ] as const)('retains retryable semantics for a %s Host preparation result', async (mode, expected, rawId) => {
    const test = harness()
    test.execution.prepareMode = mode
    const result = await test.operations.submit(
      intent('stage-files', rawId as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, reason: expected })
    if (expected === 'conflict') expect(result).toMatchObject({ receipt: { reason: 'source-conflict' } })
  })

  it('uses the fresh status baseline instead of registration-time Binding evidence', async () => {
    const fixture = statusFixture()
    if (!fixture.result.ok || fixture.result.preEffectBaseline.kind !== 'complete') {
      throw new Error('test baseline is unavailable')
    }
    const freshBaseline = {
      ...fixture.result.preEffectBaseline,
      capturedAt: fixture.result.preEffectBaseline.capturedAt + 100,
    }
    const test = harness({ ...fixture.result, preEffectBaseline: freshBaseline })
    await expect(test.operations.submit(intent('stage-files'), actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true })
    const record = [...test.intents.records.values()][0]
    expect(record?.hostRequest?.expected.preEffectBaseline).toEqual(freshBaseline)
    expect(record?.hostRequest?.expected.preEffectBaseline)
      .not.toEqual(fixture.registry.resourceBindings[0]?.inheritedChangeBaseline)
  })

  it('recovers committed acknowledgements at Intent, reserve, transition, accept, and release boundaries', async () => {
    const test = harness()
    test.intents.failAfterCommit = 'put'
    test.admissions.failAfterCommit = 'update'
    const originalUpdate = test.intents.update.bind(test.intents)
    let injectedIntentUpdate = false
    test.intents.update = async (key, fn) => {
      if (!injectedIntentUpdate) {
        injectedIntentUpdate = true
        test.intents.failAfterCommit = 'update'
      }
      return await originalUpdate(key, fn)
    }
    const result = await test.operations.submit(intent('stage-files'), actor(), new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(test.intents.size).toBe(1)
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
  })

  it('reuses an exact reservation after the admission commit wins before the Intent transition', async () => {
    const test = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000243' as SakiControlIntentId,
    )
    const update = test.intents.update.bind(test.intents)
    let interrupted = false
    test.intents.update = async (key, operation) => {
      if (!interrupted) {
        interrupted = true
        throw new Error('injected pre-transition stop')
      }
      return await update(key, operation)
    }
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
      .rejects.toThrow('injected pre-transition stop')
    expect(test.intents.get(submitted.intentId)).toMatchObject({ phase: 'prepared' })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({
      state: 'manual-host-operation',
      phase: 'reserved',
    })

    await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true })
  })

  it('rethrows reservation storage failures unless the exact reservation became durable', async () => {
    const retained = harness()
    retained.admissions.failBeforeCommit = 'update'
    const retainedIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000244' as SakiControlIntentId,
    )
    await expect(retained.operations.submit(retainedIntent, actor(), new AbortController().signal))
      .rejects.toThrow('injected update failure')
    expect(retained.intents.get(retainedIntent.intentId)).toMatchObject({ phase: 'prepared' })

    const removed = harness()
    const admissionUpdate = removed.admissions.update.bind(removed.admissions)
    removed.admissions.update = async (key, operation) => {
      removed.admissions.records.delete(key)
      void operation
      throw new Error('injected disappearing reservation')
    }
    await expect(removed.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000245' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).rejects.toThrow('injected disappearing reservation')
    removed.admissions.update = admissionUpdate
  })

  it('reuses an already accepted admission and rejects an uncommitted acceptance transition', async () => {
    const replay = harness()
    const replayIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000246' as SakiControlIntentId,
    )
    const record = await stopAfterPhase(replay, replayIntent, 'host-prepared')
    const reservation = bindingWriteAdmissionRecordSchema.parse(replay.admissions.get(BINDING_ID))
    if (reservation.state !== 'manual-host-operation' || record.preparation === undefined) {
      throw new Error('Host-prepared replay fixture is incomplete')
    }
    replay.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
      ...reservation,
      revision: reservation.revision + 1,
      phase: 'accepted',
      preparation: record.preparation,
      acceptedAt: reservation.updatedAt,
    }))
    await expect(replay.operations.submit(replayIntent, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true })

    const failed = harness()
    const failedIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000247' as SakiControlIntentId,
    )
    await stopAfterPhase(failed, failedIntent, 'host-prepared')
    failed.admissions.failBeforeCommit = 'update'
    await expect(failed.operations.submit(failedIntent, actor(), new AbortController().signal))
      .rejects.toThrow('injected update failure')
  })

  it('rejects missing, stale, and vanished Intent CAS transitions without mistaking them for acknowledgements', async () => {
    const stale = harness()
    const staleIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000248' as SakiControlIntentId,
    )
    const update = stale.intents.update.bind(stale.intents)
    stale.intents.update = async (key, operation) => {
      const current = stale.intents.records.get(key)
      if (current === undefined) throw new Error('test Intent is absent')
      const newer = gitOperationIntentRecordSchema.parse({
        ...current,
        revision: current.revision + 1,
        updatedAt: Math.max(current.updatedAt, Date.now()),
      })
      stale.intents.records.set(key, newer)
      return operation(newer)
    }
    await expect(stale.operations.submit(staleIntent, actor(), new AbortController().signal))
      .rejects.toThrow()
    stale.intents.update = update

    const vanished = harness()
    const vanishedIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000249' as SakiControlIntentId,
    )
    vanished.intents.update = async (key) => {
      vanished.intents.records.delete(key)
      throw new Error('injected vanished Intent')
    }
    await expect(vanished.operations.submit(vanishedIntent, actor(), new AbortController().signal))
      .rejects.toThrow('injected vanished Intent')

    const unchanged = harness()
    unchanged.intents.failBeforeCommit = 'update'
    await expect(unchanged.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000250' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).rejects.toThrow('injected update failure')
  })

  it('keeps a prepared Intent retryable when reservation storage acknowledges a different admission state', async () => {
    const test = harness()
    const update = test.admissions.update.bind(test.admissions)
    test.admissions.update = async (key, operation) => {
      const committed = await update(key, operation)
      return availableAdmission(committed.revision)
    }
    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000390' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'prepared' },
    })
  })

  it.each(['available', 'reserved'] as const)(
    'keeps a Host-prepared Intent retryable when acceptance storage acknowledges %s',
    async (acknowledged) => {
      const test = harness()
      const submitted = intent(
        'stage-files',
        `intent-00000000-0000-4000-8000-00000000039${acknowledged === 'available' ? '1' : '2'}` as SakiControlIntentId,
      )
      await stopAfterPhase(test, submitted, 'host-prepared')
      const update = test.admissions.update.bind(test.admissions)
      test.admissions.update = async (key, operation) => {
        const before = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(key))
        const committed = await update(key, operation)
        return acknowledged === 'available' ? availableAdmission(committed.revision) : before
      }
      await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
        .resolves.toMatchObject({
          ok: false,
          reason: 'unavailable',
          receipt: { state: 'host-prepared' },
        })
    },
  )

  it('recovers a committed available-row write before registration confirmation', async () => {
    const test = harness()
    const binding = test.registry.resourceBindings[0]
    if (binding === undefined) throw new Error('test Binding is absent')
    test.admissions.records.delete(BINDING_ID)
    test.admissions.failAfterCommit = 'put'

    await expect(test.operations.ensureBindingWriteAdmission(binding)).resolves.toBeUndefined()
    expect(test.admissions.get(BINDING_ID)).toMatchObject({
      id: BINDING_ID,
      revision: 0,
      state: 'available',
    })
  })

  it('makes Binding admission creation idempotent and rejects divergent or uncommitted storage outcomes', async () => {
    const binding = harness().registry.resourceBindings[0]
    if (binding === undefined) throw new Error('test Binding is absent')

    const existing = harness()
    await expect(existing.operations.ensureBindingWriteAdmission(binding)).resolves.toBeUndefined()

    const otherBindingId = 'binding-00000000-0000-4000-8000-000000000235' as SakiResourceBindingId
    existing.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
      ...availableAdmission(),
      id: otherBindingId,
    }))
    await expect(existing.operations.ensureBindingWriteAdmission(binding))
      .rejects.toThrow('admission id disagrees with its key')

    const failed = harness()
    failed.admissions.records.delete(BINDING_ID)
    failed.admissions.failBeforeCommit = 'put'
    await expect(failed.operations.ensureBindingWriteAdmission(binding)).rejects.toThrow('injected put failure')
  })

  it('rejects uncommitted and divergent Intent writes while replaying only the exact durable payload', async () => {
    const absent = harness()
    absent.intents.failBeforeCommit = 'put'
    await expect(absent.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000236' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).rejects.toThrow('injected put failure')

    const divergent = harness()
    divergent.intents.put = async (key, value) => {
      const payload = {
        ...value.payload,
        actor: { ...value.payload.actor, principalRevision: value.payload.actor.principalRevision + 1 },
      }
      divergent.intents.records.set(key, gitOperationIntentRecordSchema.parse({
        ...value,
        payload,
        payloadDigest: canonicalDigest('saki/git-operation-intent/v1', payload),
        hostRequest: undefined,
        phase: 'conflict',
        terminalReason: 'expected-evidence',
      }))
      throw new Error('injected divergent put race')
    }
    await expect(divergent.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000237' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).rejects.toThrow('injected divergent put race')
  })

  it.each([
    ['prepared', 'prepared', 'intent-00000000-0000-4000-8000-000000000385'],
    ['admission-reserved', 'admission-reserved', 'intent-00000000-0000-4000-8000-000000000386'],
    ['host-prepared', 'host-prepared', 'intent-00000000-0000-4000-8000-000000000387'],
    ['accepted', 'accepted', 'intent-00000000-0000-4000-8000-000000000388'],
  ] as const)(
    'returns the durable %s winner when a pre-Host conflict loses its put race',
    async (phase, receiptState, rawId) => {
      const submitted = intent('stage-files', rawId as SakiControlIntentId)
      const winner = harness()
      let record: GitOperationIntentRecord
      if (phase === 'prepared') {
        winner.admissions.records.delete(BINDING_ID)
        await expect(winner.operations.submit(submitted, actor(), new AbortController().signal))
          .resolves.toMatchObject({ ok: false, reason: 'unavailable' })
        record = gitOperationIntentRecordSchema.parse(winner.intents.get(submitted.intentId))
      } else if (phase === 'accepted') {
        winner.execution.startMode = 'busy-then-succeed-notification'
        await expect(winner.operations.submit(submitted, actor(), new AbortController().signal))
          .resolves.toMatchObject({ ok: false, reason: 'unavailable' })
        record = gitOperationIntentRecordSchema.parse(winner.intents.get(submitted.intentId))
      } else {
        record = await stopAfterPhase(winner, submitted, phase)
      }
      expect(record.phase).toBe(phase)

      const contender = harness()
      const inspected = statusFixture().result
      if (!inspected.ok) throw new Error('test status is unavailable')
      contender.execution.inspectResult = {
        ...inspected,
        observation: {
          ...inspected.observation,
          fingerprint: { version: 1, digest: 'f'.repeat(64) },
        },
      }
      contender.intents.put = async (key) => {
        contender.intents.records.set(key, record)
        throw new Error('injected competing put acknowledgement loss')
      }

      await expect(contender.operations.submit(submitted, actor(), new AbortController().signal))
        .resolves.toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: receiptState } })
    },
  )

  it('rejects a durable receipt whose operation kind changes between correlated reads', async () => {
    const rawId = 'intent-00000000-0000-4000-8000-000000000389' as SakiControlIntentId
    const stale = (type: 'stage-files' | 'unstage-files') => {
      const submitted = intent(type, rawId)
      return {
        ...submitted,
        expected: { ...submitted.expected, expectedProjectRevision: submitted.expected.expectedProjectRevision + 1 },
      }
    }
    const submitted = stale('stage-files') as StageFilesIntent
    const stage = harness()
    await stage.operations.submit(submitted, actor(), new AbortController().signal)
    const stageRecord = gitOperationIntentRecordSchema.parse(stage.intents.get(rawId))
    const unstage = harness()
    await unstage.operations.submit(stale('unstage-files') as UnstageFilesIntent, actor(), new AbortController().signal)
    const unstageRecord = gitOperationIntentRecordSchema.parse(unstage.intents.get(rawId))

    const changed = harness()
    let reads = 0
    changed.intents.get = () => reads++ === 0 ? stageRecord : unstageRecord
    await expect(changed.operations.submit(submitted, actor(), new AbortController().signal))
      .rejects.toThrow(`Git operation result kind disagrees with Intent '${rawId}'`)
  })

  it('validates only a prepared Intent across a recoverable registration admission gap', async () => {
    const test = harness()
    const submitted = intent('stage-files')
    test.admissions.records.delete(BINDING_ID)

    await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'prepared' },
    })
    const prepared = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    expect(() => validateGitOperationsDurableState(
      test.intents,
      test.admissions,
      test.registry,
      new Set(),
      new Set([BINDING_ID]),
      () => {},
    )).not.toThrow()

    test.intents.records.set(submitted.intentId, gitOperationIntentRecordSchema.parse({
      ...prepared,
      phase: 'admission-reserved',
      reservationRevision: 0,
    }))
    expect(() => validateGitOperationsDurableState(
      test.intents,
      test.admissions,
      test.registry,
      new Set(),
      new Set([BINDING_ID]),
      () => {},
    )).toThrow('Git operation Intent Binding has no write admission')
  })

  it('leaves caller-aborted preparation durable and resumes it with a fresh caller', async () => {
    const test = harness()
    const submitted = intent('stage-files')
    const controller = new AbortController()
    test.execution.afterPrepare = () => { controller.abort(new Error('caller stopped')) }

    await expect(test.operations.submit(submitted, actor(), controller.signal)).rejects.toThrow('caller stopped')
    expect(test.intents.get(submitted.intentId)).toMatchObject({ phase: 'admission-reserved' })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({
      state: 'manual-host-operation',
      phase: 'reserved',
    })

    test.execution.afterPrepare = undefined
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
  })

  it('cancels a prepared operation after current Grant revocation without starting an effect', async () => {
    const test = harness()
    test.execution.afterPrepare = () => { test.authority = false }
    const result = await test.operations.submit(intent('stage-files'), actor(), new AbortController().signal)
    expect(result).toMatchObject({ ok: false, reason: 'canceled', receipt: { reason: 'authority-revoked' } })
    expect(test.execution.startCount).toBe(0)
    expect(test.execution.cancelCount).toBe(1)
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
  })

  it('recovers committed admission-fence clearing when Binding authority changes at Host acceptance', async () => {
    const test = harness()
    test.execution.beforeAdmission = () => { test.bindingCurrent = false }
    const submitted = intent('stage-files')
    const update = test.intents.update.bind(test.intents)
    let lostAcknowledgement = false
    test.intents.update = async (key, fn) => await update(key, (current) => {
      const next = fn(current)
      if (current.admissionRevision !== undefined
        && next.phase === 'canceled'
        && !Object.hasOwn(next, 'admissionRevision')) {
        lostAcknowledgement = true
        test.intents.failAfterCommit = 'update'
      }
      return next
    })

    await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      reason: 'canceled',
      receipt: { state: 'canceled', reason: 'source-canceled' },
    })
    expect(lostAcknowledgement).toBe(true)
    const record = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    expect(Object.hasOwn(record, 'admissionRevision')).toBe(false)
    expect(record.operationSnapshot).toMatchObject({
      state: 'canceled',
      admission: { kind: 'not-accepted' },
      effect: 'none',
    })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
  })

  it.each([
    ['source', (value: HostOperationAdmissionExpectation) => ({
      ...value,
      source: { ...value.source, payloadDigest: 'f'.repeat(64) },
    })],
    ['source family', (value: HostOperationAdmissionExpectation) => ({
      ...value,
      source: {
        kind: 'execution-dispatch' as const,
        dispatchId: 'dispatch-00000000-0000-4000-8000-000000000393' as SakiExecutionDispatchId,
        payloadDigest: value.source.payloadDigest,
      },
    })],
    ['preparation', (value: HostOperationAdmissionExpectation) => ({
      ...value,
      preparation: {
        ...value.preparation,
        requestFingerprint: { ...value.preparation.requestFingerprint, digest: 'f'.repeat(64) },
      },
    })],
    ['binding id', (value: HostOperationAdmissionExpectation) => ({
      ...value,
      bindingId: 'binding-00000000-0000-4000-8000-000000000238' as SakiResourceBindingId,
    })],
    ['binding revision', (value: HostOperationAdmissionExpectation) => ({
      ...value,
      bindingRevision: value.bindingRevision + 1,
    })],
  ] as const)('denies a Host admission with stale %s evidence', async (_name, mutate) => {
    const test = harness()
    test.execution.admissionExpectation = mutate
    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000239' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toMatchObject({
      ok: false,
      reason: 'canceled',
      receipt: { reason: 'source-canceled' },
    })
  })

  it.each([
    ['missing', (test: Harness) => { test.admissions.records.delete(BINDING_ID) }, 'unavailable'],
    ['malformed', (test: Harness) => { test.admissions.records.set(BINDING_ID, { hostile: true } as never) }, 'unavailable'],
    ['available', (test: Harness) => { test.admissions.records.set(BINDING_ID, availableAdmission(3)) }, 'canceled'],
    ['reserved', (test: Harness) => {
      const current = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(BINDING_ID))
      if (current.state !== 'manual-host-operation') throw new Error('test admission is unavailable')
      const { preparation: _preparation, acceptedAt: _acceptedAt, ...retained } = current as Extract<
        BindingWriteAdmissionRecord,
        { readonly state: 'manual-host-operation'; readonly phase: 'accepted' }
      >
      test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({ ...retained, phase: 'reserved' }))
    }, 'canceled'],
    ['wrong revision', (test: Harness) => {
      const current = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(BINDING_ID))
      test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
        ...current,
        revision: current.revision + 1,
      }))
    }, 'canceled'],
    ['wrong source revision', (test: Harness) => {
      const current = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(BINDING_ID))
      if (current.state !== 'manual-host-operation') throw new Error('test admission is unavailable')
      test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
        ...current,
        source: { ...current.source, intentRevision: current.source.intentRevision + 1 },
      }))
    }, 'canceled'],
  ] as const)('fails closed when the current admission is %s', async (_name, mutate, reason) => {
    const test = harness()
    test.execution.beforeAdmission = () => { mutate(test) }
    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000240' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: false, reason })
  })

  it.each([
    ['not-current phase', (test: Harness) => {
      const current = gitOperationIntentRecordSchema.parse([...test.intents.records.values()][0])
      const { admissionRevision: _admissionRevision, ...retained } = current
      test.intents.records.set(current.id, gitOperationIntentRecordSchema.parse({
        ...retained,
        phase: 'host-prepared',
      }))
    }],
    ['canceled source', (test: Harness) => {
      const current = gitOperationIntentRecordSchema.parse([...test.intents.records.values()][0])
      const { admissionRevision: _admissionRevision, ...retained } = current
      test.intents.records.set(current.id, gitOperationIntentRecordSchema.parse({
        ...retained,
        phase: 'conflict',
        terminalReason: 'source-conflict',
      }))
    }],
  ] as const)('denies Host admission for a %s Intent record', async (_name, mutate) => {
    const test = harness()
    test.execution.beforeAdmission = () => { mutate(test) }
    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000241' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: false, reason: 'canceled' })
  })

  it.each([
    ['project revision', (test: Harness) => {
      test.currentBinding = { ...test.currentBinding, projectRevision: test.currentBinding.projectRevision + 1 }
    }],
    ['Binding evidence', (test: Harness) => {
      test.currentBinding = {
        ...test.currentBinding,
        binding: { ...test.currentBinding.binding, revision: test.currentBinding.binding.revision + 1 },
      }
    }],
    ['authority', (test: Harness) => { test.authority = false }],
  ] as const)('rechecks current %s at the Host admission boundary', async (_name, mutate) => {
    const test = harness()
    test.execution.beforeAdmission = () => { mutate(test) }
    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000242' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: false, reason: 'canceled' })
  })

  it('rejects Host admission when retained operation authority diverges from the current Binding Host', async () => {
    const test = harness()
    let originalIntent: GitOperationIntentRecord | undefined
    let originalAdmission: BindingWriteAdmissionRecord | undefined
    test.execution.beforeAdmission = () => {
      const current = gitOperationIntentRecordSchema.parse([...test.intents.records.values()][0])
      const admission = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(BINDING_ID))
      if (current.preparation === undefined || current.operationSnapshot === undefined
        || admission.state !== 'manual-host-operation' || admission.phase !== 'accepted') {
        throw new Error('test operation has not reached accepted admission')
      }
      originalIntent = current
      originalAdmission = admission
      const operation = { ...current.preparation.operation, hostId: OTHER_HOST_ID }
      const preparation = { ...current.preparation, operation }
      test.intents.records.set(current.id, gitOperationIntentRecordSchema.parse({
        ...current,
        preparation,
        operationSnapshot: { ...current.operationSnapshot, operation },
      }))
      test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
        ...admission,
        preparation,
      }))
      test.execution.admissionExpectation = value => ({ ...value, preparation })
    }
    test.execution.afterAdmission = () => {
      if (originalIntent === undefined || originalAdmission === undefined) {
        throw new Error('test operation authority was not captured')
      }
      test.intents.records.set(originalIntent.id, originalIntent)
      test.admissions.records.set(BINDING_ID, originalAdmission)
    }

    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000243' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: false, reason: 'canceled' })
  })

  for (const state of ['planning', 'publishing'] as const) {
    it(`cancels a ${state} operation after current Grant revocation`, async () => {
      const test = harness()
      test.execution.startMode = `throw-after-${state}`
      const submitted = intent('stage-files')
      await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
        .rejects.toThrow(`injected ${state} acknowledgement loss`)
      expect(test.intents.get(submitted.intentId)).toMatchObject({ phase: 'accepted' })
      expect([...test.execution.operations.values()][0]?.snapshot).toMatchObject({ state })

      test.authority = false
      await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).resolves.toMatchObject({
        ok: false,
        reason: 'canceled',
        receipt: { state: 'canceled', reason: 'authority-revoked' },
      })
      expect(test.execution.cancelCount).toBe(1)
      expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
    })
  }

  it('recovers start acknowledgement loss by inspecting the same Host Operation', async () => {
    const test = harness()
    test.execution.startMode = 'throw-after-success'
    const submitted = intent('stage-files')
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
      .rejects.toThrow('start acknowledgement loss')
    expect(test.intents.get(submitted.intentId)).toMatchObject({ phase: 'accepted' })
    test.execution.startMode = 'succeed'
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(test.execution.startCount).toBe(1)
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
  })

  it('reinspects an exact terminal Host snapshot before releasing retained admission on replay', async () => {
    const test = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000279' as SakiControlIntentId,
    )
    const terminal = await test.operations.submit(submitted, actor(), new AbortController().signal)
    const record = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    test.admissions.records.set(BINDING_ID, retainedAcceptedAdmission(record))
    const inspectionsBeforeReplay = test.execution.inspectCount

    await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).resolves.toEqual(terminal)
    expect(test.execution.inspectCount).toBe(inspectionsBeforeReplay + 1)
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
  })

  it.each([
    ['succeeded', 'succeed', 'intent-00000000-0000-4000-8000-000000000280'],
    ['canceled', 'cancel', 'intent-00000000-0000-4000-8000-000000000281'],
  ] as const)('reinspects a %s Host snapshot before startup releases retained admission', async (phase, mode, id) => {
    const test = harness()
    test.execution.startMode = mode
    const submitted = intent('stage-files', id as SakiControlIntentId)
    await test.operations.submit(submitted, actor(), new AbortController().signal)
    const record = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    expect(record.phase).toBe(phase)
    test.admissions.records.set(BINDING_ID, retainedAcceptedAdmission(record))
    const validated = test.operations.validateDurableState(new Set(), test.registry)
    const inspectionsBeforeRecovery = test.execution.inspectCount

    await expect(test.operations.initializeValidated(validated)).resolves.toBeUndefined()
    expect(test.execution.inspectCount).toBe(inspectionsBeforeRecovery + 1)
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
  })

  it('rejects a terminal Host snapshot that differs from the validated durable snapshot', async () => {
    const test = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000282' as SakiControlIntentId,
    )
    await test.operations.submit(submitted, actor(), new AbortController().signal)
    const record = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    test.admissions.records.set(BINDING_ID, retainedAcceptedAdmission(record))
    const validated = test.operations.validateDurableState(new Set(), test.registry)
    const operation = requiredFakeOperation(test)
    operation.snapshot = {
      ...operation.snapshot,
      revision: operation.snapshot.revision + 1,
      updatedAt: operation.snapshot.updatedAt + 1,
    }

    await expect(test.operations.initializeValidated(validated))
      .rejects.toThrow('Host terminal snapshot disagrees')
    expect(test.admissions.get(BINDING_ID)).toMatchObject({
      state: 'manual-host-operation',
      source: { intentId: submitted.intentId },
    })
  })

  it('retains accepted admission while Host effect evidence requires reconciliation', async () => {
    const test = harness()
    test.execution.startMode = 'reconciliation'
    const submitted = intent('stage-files')
    const result = await test.operations.submit(submitted, actor(), new AbortController().signal)
    expect(result).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'effect-unknown' },
    })
    expect(test.intents.get(submitted.intentId)).toMatchObject({ phase: 'reconciliation-required' })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({
      state: 'manual-host-operation',
      phase: 'accepted',
    })
    expect(() => validateGitOperationsDurableState(
      test.intents,
      test.admissions,
      test.registry,
      new Set(),
      new Set(),
      () => {},
    )).not.toThrow()
  })

  it('retains one CAS winner while a different Intent waits, then resumes the waiter after release', async () => {
    const test = harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let pause = true
    test.execution.beforePrepare = async () => {
      if (pause) {
        pause = false
        entered.resolve(undefined)
        await release.promise
      }
    }
    const first = intent('stage-files', 'intent-00000000-0000-4000-8000-000000000023' as SakiControlIntentId)
    const second = intent('unstage-files', 'intent-00000000-0000-4000-8000-000000000024' as SakiControlIntentId)
    const firstRun = test.operations.submit(first, actor(), new AbortController().signal)
    await entered.promise
    const waiting = await test.operations.submit(second, actor(), new AbortController().signal)
    expect(waiting).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    release.resolve(undefined)
    await expect(firstRun).resolves.toMatchObject({ ok: true })
    await expect(test.operations.submit(second, actor(), new AbortController().signal)).resolves.toMatchObject({ ok: true })
  })

  it('recovers a newer reserved Intent after an older terminal Intent already released admission', async () => {
    const beforeCrash = harness()
    const completed = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000025' as SakiControlIntentId,
    )
    await expect(beforeCrash.operations.submit(completed, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true, receipt: { state: 'succeeded' } })

    const interrupted = intent(
      'unstage-files',
      'intent-00000000-0000-4000-8000-000000000026' as SakiControlIntentId,
    )
    const controller = new AbortController()
    beforeCrash.execution.afterPrepare = () => { controller.abort(new Error('process stopped')) }
    await expect(beforeCrash.operations.submit(interrupted, actor(), controller.signal)).rejects.toThrow('process stopped')
    expect(beforeCrash.intents.get(interrupted.intentId)).toMatchObject({ phase: 'admission-reserved' })
    expect(beforeCrash.admissions.get(BINDING_ID)).toMatchObject({
      state: 'manual-host-operation',
      source: { intentId: interrupted.intentId },
    })

    const restarted = harness()
    restarted.intents.records.clear()
    for (const [id, record] of beforeCrash.intents.records) restarted.intents.records.set(id, record)
    restarted.admissions.records.clear()
    for (const [id, admission] of beforeCrash.admissions.records) restarted.admissions.records.set(id, admission)
    for (const [id, operation] of beforeCrash.execution.operations) restarted.execution.operations.set(id, operation)

    const validated = restarted.operations.validateDurableState(new Set(), restarted.registry)
    await expect(restarted.operations.initializeValidated(validated)).resolves.toBeUndefined()
    expect(restarted.intents.get(interrupted.intentId)).toMatchObject({ phase: 'succeeded' })
    expect(restarted.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
  })

  it('recovers the durable owner before older prepared waiters in deterministic order', async () => {
    const test = harness()
    const owner = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000285' as SakiControlIntentId,
    )
    await stopAfterPhase(test, owner, 'accepted')
    const firstWaiter = intent(
      'unstage-files',
      'intent-00000000-0000-4000-8000-000000000283' as SakiControlIntentId,
    )
    const secondWaiter = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000284' as SakiControlIntentId,
    )
    await expect(test.operations.submit(firstWaiter, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    await expect(test.operations.submit(secondWaiter, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    for (const [id, createdAt] of [
      [firstWaiter.intentId, 1],
      [secondWaiter.intentId, 2],
      [owner.intentId, 3],
    ] as const) {
      const record = gitOperationIntentRecordSchema.parse(test.intents.get(id))
      test.intents.records.set(id, gitOperationIntentRecordSchema.parse({ ...record, createdAt }))
    }

    const validated = test.operations.validateDurableState(new Set(), test.registry)
    expect(validated.intents.map(record => record.id)).toEqual([
      owner.intentId,
      firstWaiter.intentId,
      secondWaiter.intentId,
    ])
    await expect(test.operations.initializeValidated(validated)).resolves.toBeUndefined()
    expect(test.execution.startedIntentIds).toEqual([
      owner.intentId,
      firstWaiter.intentId,
      secondWaiter.intentId,
    ])
    expect(test.intents.get(owner.intentId)).toMatchObject({ phase: 'succeeded' })
    expect(test.intents.get(firstWaiter.intentId)).toMatchObject({ phase: 'succeeded' })
    expect(test.intents.get(secondWaiter.intentId)).toMatchObject({ phase: 'succeeded' })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
  })

  it('makes one bounded startup pass when the durable owner remains unavailable', async () => {
    const test = harness()
    const owner = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000288' as SakiControlIntentId,
    )
    await stopAfterPhase(test, owner, 'accepted')
    const waiters = [
      intent('unstage-files', 'intent-00000000-0000-4000-8000-000000000286' as SakiControlIntentId),
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000287' as SakiControlIntentId),
    ]
    for (const waiter of waiters) {
      await expect(test.operations.submit(waiter, actor(), new AbortController().signal))
        .resolves.toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    }
    test.execution.startMode = 'unavailable'

    const validated = test.operations.validateDurableState(new Set(), test.registry)
    await expect(test.operations.initializeValidated(validated)).resolves.toBeUndefined()

    expect(test.execution.startedIntentIds).toEqual([owner.intentId])
    expect(test.intents.get(owner.intentId)).toMatchObject({ phase: 'accepted' })
    for (const waiter of waiters) {
      expect(test.intents.get(waiter.intentId)).toMatchObject({ phase: 'prepared' })
    }
    expect(test.admissions.get(BINDING_ID)).toMatchObject({
      state: 'manual-host-operation',
      source: { intentId: owner.intentId },
    })
  })

  it('replays an older terminal receipt while a newer Intent owns admission', async () => {
    const test = harness()
    const completed = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000027' as SakiControlIntentId,
    )
    const terminal = await test.operations.submit(completed, actor(), new AbortController().signal)
    expect(terminal).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })

    const interrupted = intent(
      'unstage-files',
      'intent-00000000-0000-4000-8000-000000000028' as SakiControlIntentId,
    )
    const controller = new AbortController()
    test.execution.afterPrepare = () => { controller.abort(new Error('caller stopped')) }
    await expect(test.operations.submit(interrupted, actor(), controller.signal)).rejects.toThrow('caller stopped')

    await expect(test.operations.submit(completed, actor(), new AbortController().signal)).resolves.toEqual(terminal)
    expect(test.admissions.get(BINDING_ID)).toMatchObject({
      state: 'manual-host-operation',
      source: { intentId: interrupted.intentId },
    })
  })

  it('replays a terminal receipt when release acknowledgement is lost and a valid newer owner reserves', async () => {
    const first = harness()
    const completed = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000032' as SakiControlIntentId,
    )
    const terminal = await first.operations.submit(completed, actor(), new AbortController().signal)
    expect(terminal).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    const completedRecord = gitOperationIntentRecordSchema.parse(first.intents.get(completed.intentId))
    if (completedRecord.hostRequest === undefined || completedRecord.preparation === undefined) {
      throw new Error('terminal fixture has no Host evidence')
    }

    const second = harness()
    const newer = intent(
      'unstage-files',
      'intent-00000000-0000-4000-8000-000000000033' as SakiControlIntentId,
    )
    const controller = new AbortController()
    second.execution.afterPrepare = () => { controller.abort(new Error('caller stopped')) }
    await expect(second.operations.submit(newer, actor(), controller.signal)).rejects.toThrow('caller stopped')
    const newerRecord = gitOperationIntentRecordSchema.parse(second.intents.get(newer.intentId))
    const newerAdmission = bindingWriteAdmissionRecordSchema.parse(second.admissions.get(BINDING_ID))
    expect(newerAdmission).toMatchObject({
      state: 'manual-host-operation',
      source: { intentId: newer.intentId },
    })
    first.intents.records.set(newer.intentId, newerRecord)
    const now = Date.now()
    first.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
      id: BINDING_ID,
      schemaVersion: 1,
      revision: newerAdmission.revision + 1,
      state: 'manual-host-operation',
      phase: 'accepted',
      bindingRevision: completedRecord.hostRequest.expected.binding.revision,
      source: completedRecord.hostRequest.source,
      action: 'project-changes:stage',
      reservedAt: now,
      preparation: completedRecord.preparation,
      acceptedAt: now,
      updatedAt: now,
    }))
    const originalUpdate = first.admissions.update.bind(first.admissions)
    let injected = false
    first.admissions.update = async (key, update) => {
      if (injected) return await originalUpdate(key, update)
      injected = true
      const current = first.admissions.records.get(key)
      if (current === undefined) throw new Error('missing-key')
      first.admissions.records.set(key, update(current))
      first.admissions.records.set(key, newerAdmission)
      throw new Error('injected release acknowledgement loss')
    }

    await expect(first.operations.submit(completed, actor(), new AbortController().signal)).resolves.toEqual(terminal)
    expect(first.admissions.get(BINDING_ID)).toEqual(newerAdmission)
  })

  it('cancels a prepared waiter after authority revocation without releasing another Intent', async () => {
    const test = harness()
    const owner = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000029' as SakiControlIntentId,
    )
    const controller = new AbortController()
    test.execution.afterPrepare = () => { controller.abort(new Error('caller stopped')) }
    await expect(test.operations.submit(owner, actor(), controller.signal)).rejects.toThrow('caller stopped')
    test.execution.afterPrepare = undefined

    const waiter = intent(
      'unstage-files',
      'intent-00000000-0000-4000-8000-000000000030' as SakiControlIntentId,
    )
    await expect(test.operations.submit(waiter, actor(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'prepared' },
    })
    expect(test.intents.get(waiter.intentId)).toMatchObject({ phase: 'prepared' })

    test.authority = false
    await expect(test.operations.submit(waiter, actor(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      reason: 'canceled',
      receipt: { state: 'canceled', reason: 'authority-revoked' },
    })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({
      state: 'manual-host-operation',
      source: { intentId: owner.intentId },
    })
  })

  it('keeps a revoked prepared Intent recoverable while registration admission is missing', async () => {
    const test = harness()
    const submitted = intent('stage-files')
    test.admissions.records.delete(BINDING_ID)
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'prepared' },
    })

    test.authority = false
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'prepared' },
    })
    expect(test.intents.get(submitted.intentId)).toMatchObject({ phase: 'prepared' })
  })

  it('releases a terminal owner recovered across the reserve-to-Intent acknowledgement gap', async () => {
    const test = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000031' as SakiControlIntentId,
    )
    const controller = new AbortController()
    test.execution.afterPrepare = () => { controller.abort(new Error('process stopped')) }
    await expect(test.operations.submit(submitted, actor(), controller.signal)).rejects.toThrow('process stopped')
    const reserved = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    test.intents.records.set(submitted.intentId, gitOperationIntentRecordSchema.parse({
      ...reserved,
      revision: reserved.revision + 1,
      phase: 'canceled',
      reservationRevision: undefined,
      terminalReason: 'authority-revoked',
      updatedAt: Math.max(reserved.updatedAt, Date.now()),
    }))

    const validated = test.operations.validateDurableState(new Set(), test.registry)
    await test.operations.initializeValidated(validated)
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
  })

  it('uses an initialize-time Host notification to recover a fast terminal operation', async () => {
    const test = harness()
    test.execution.startMode = 'busy-then-succeed-notification'
    const submitted = intent('stage-files')
    const prepared = await test.operations.submit(submitted, actor(), new AbortController().signal)
    expect(prepared.ok).toBe(false)
    const record = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    expect(record.phase).toBe('accepted')
    if (record.operationSnapshot === undefined) throw new Error('test accepted Intent has no Host snapshot')
    const operation = test.execution.operations.values().next().value
    if (operation === undefined) throw new Error('test Host Operation is absent')
    operation.snapshot = record.operationSnapshot
    const restarted = harness()
    restarted.execution.startMode = 'busy-then-succeed-notification'
    restarted.intents.records.set(record.id, record)
    restarted.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse(test.admissions.get(BINDING_ID)))
    for (const [id, operation] of test.execution.operations) restarted.execution.operations.set(id, operation)
    const dispose = restarted.execution.onChanged((change) => { restarted.operations.hostChanged(change) })
    await restarted.operations.initializeValidated({ intents: [record] })
    await restarted.operations.dispose()
    expect(restarted.intents.get(record.id)).toMatchObject({ phase: 'succeeded' })
    dispose()
  })

  it('rejects a self-consistent durable Host request whose private Binding authority differs from the Registry', async () => {
    const test = harness()
    const submitted = intent('stage-files')
    const controller = new AbortController()
    test.execution.afterPrepare = () => { controller.abort(new Error('stop before Host preparation is retained')) }
    await expect(test.operations.submit(submitted, actor(), controller.signal))
      .rejects.toThrow('stop before Host preparation is retained')
    const record = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    expect(record.phase).toBe('admission-reserved')
    if (record.hostRequest === undefined) throw new Error('test Git Intent has no Host request')

    const hostileWorkspaceId = 'workspace-hostile' as typeof WORKSPACE_ID
    const hostileTrusted = {
      ...record.hostRequest.expected.binding.expectedInspection.trusted,
      canonicalWorktreePath: '/fixture/hostile-repository',
      canonicalGitDirectory: '/fixture/hostile-repository/.git',
      canonicalCommonGitDirectory: '/fixture/hostile-repository/.git',
    }
    const hostileProjection = {
      ...record.hostRequest.expected.binding.expectedInspection.projection,
      workspaceId: hostileWorkspaceId,
    }
    const hostile = gitOperationIntentRecordSchema.parse({
      ...record,
      hostRequest: {
        ...record.hostRequest,
        expected: {
          ...record.hostRequest.expected,
          binding: {
            ...record.hostRequest.expected.binding,
            workspaceId: hostileWorkspaceId,
            expectedInspection: {
              projection: {
                ...hostileProjection,
                fingerprint: computeProjectInspectionFingerprint(hostileProjection, hostileTrusted),
              },
              trusted: hostileTrusted,
            },
          },
        },
      },
    })
    test.intents.records.set(hostile.id, hostile)

    expect(() => validateGitOperationsDurableState(
      test.intents,
      test.admissions,
      test.registry,
      new Set(),
      new Set(),
      () => {},
    )).toThrow('Binding authority')
  })

  it('validates every durable Intent, admission, Registry, and recovery-order relationship', async () => {
    const emptyIntents = new MemoryTable<SakiControlIntentId, GitOperationIntentRecord>()
    const emptyAdmissions = new MemoryTable<SakiResourceBindingId, BindingWriteAdmissionRecord>()
    expect(validateGitOperationsDurableState(
      emptyIntents,
      emptyAdmissions,
      undefined,
      new Set(),
      new Set(),
      () => {},
    )).toEqual({ intents: [] })

    const reserved = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000229' as SakiControlIntentId,
    )
    const reservedRecord = await stopAfterPhase(reserved, submitted, 'admission-reserved')
    const reservedAdmission = bindingWriteAdmissionRecordSchema.parse(reserved.admissions.get(BINDING_ID))
    if (reservedRecord.hostRequest === undefined || reservedAdmission.state !== 'manual-host-operation') {
      throw new Error('reserved validation fixture is incomplete')
    }

    expect(() => validateGitOperationsDurableState(
      reserved.intents,
      reserved.admissions,
      undefined,
      new Set(),
      new Set(),
      () => {},
    )).toThrow('state exists without the Project Registry')
    expect(() => validateGitOperationsDurableState(
      emptyIntents,
      reserved.admissions,
      undefined,
      new Set(),
      new Set(),
      () => {},
    )).toThrow('state exists without the Project Registry')

    const otherIntentKey = 'intent-00000000-0000-4000-8000-000000000230' as SakiControlIntentId
    expect(() => validateGitOperationsDurableState(
      new MemoryTable([[otherIntentKey, reservedRecord]]),
      reserved.admissions,
      reserved.registry,
      new Set(),
      new Set(),
      () => {},
    )).toThrow('Intent id disagrees with its table key')
    expect(() => validateGitOperationsDurableState(
      reserved.intents,
      emptyAdmissions,
      reserved.registry,
      new Set(),
      new Set(),
      () => {},
    )).toThrow('Resource Binding has no write admission')

    const otherBindingId = 'binding-00000000-0000-4000-8000-000000000231' as SakiResourceBindingId
    const mismatchedAdmission = bindingWriteAdmissionRecordSchema.parse({
      ...availableAdmission(),
      id: otherBindingId,
    })
    expect(() => validateGitOperationsDurableState(
      reserved.intents,
      new MemoryTable([[BINDING_ID, mismatchedAdmission]]),
      reserved.registry,
      new Set(),
      new Set(),
      () => {},
    )).toThrow('admission id disagrees with its table key')
    expect(() => validateGitOperationsDurableState(
      reserved.intents,
      new MemoryTable([
        [BINDING_ID, availableAdmission()],
        [otherBindingId, mismatchedAdmission],
      ]),
      reserved.registry,
      new Set(),
      new Set(),
      () => {},
    )).toThrow('admission has no Resource Binding')
    expect(() => validateGitOperationsDurableState(
      emptyIntents,
      reserved.admissions,
      reserved.registry,
      new Set(),
      new Set(),
      () => {},
    )).toThrow('admission has no Git operation Intent')

    const futurePayload = {
      ...reservedRecord.payload,
      intent: {
        ...reservedRecord.payload.intent,
        expected: {
          ...reservedRecord.payload.intent.expected,
          expectedBinding: { ...reservedRecord.payload.intent.expected.expectedBinding, revision: 1 },
        },
      },
    }
    const futureDigest = canonicalDigest('saki/git-operation-intent/v1', futurePayload)
    const futureRequest = {
      ...reservedRecord.hostRequest,
      source: { ...reservedRecord.hostRequest.source, payloadDigest: futureDigest },
      expected: {
        ...reservedRecord.hostRequest.expected,
        binding: { ...reservedRecord.hostRequest.expected.binding, revision: 1 },
      },
    }
    const futureRecord = gitOperationIntentRecordSchema.parse({
      ...reservedRecord,
      payload: futurePayload,
      payloadDigest: futureDigest,
      hostRequest: futureRequest,
    })
    const futureAdmission = bindingWriteAdmissionRecordSchema.parse({
      ...reservedAdmission,
      bindingRevision: 1,
      source: futureRequest.source,
    })
    expect(() => validateGitOperationsDurableState(
      new MemoryTable([[futureRecord.id, futureRecord]]),
      new MemoryTable([[BINDING_ID, futureAdmission]]),
      reserved.registry,
      new Set(),
      new Set(),
      () => {},
    )).toThrow('targets a future Binding revision')

    expect(() => validateGitOperationsDurableState(
      reserved.intents,
      reserved.admissions,
      { ...reserved.registry, projects: [] },
      new Set(),
      new Set(),
      () => {},
    )).toThrow('Intent target is inconsistent')
    expect(() => validateGitOperationsDurableState(
      reserved.intents,
      new MemoryTable([[BINDING_ID, availableAdmission()]]),
      reserved.registry,
      new Set(),
      new Set(),
      () => {},
    )).toThrow('Intent has no matching write admission')

    const accepted = harness()
    const acceptedIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000232' as SakiControlIntentId,
    )
    await stopAfterPhase(accepted, acceptedIntent, 'accepted')
    const acceptedAdmission = bindingWriteAdmissionRecordSchema.parse(accepted.admissions.get(BINDING_ID))
    expect(() => validateGitOperationsDurableState(
      accepted.intents,
      new MemoryTable([[BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
        ...acceptedAdmission,
        revision: acceptedAdmission.revision + 1,
      })]]),
      accepted.registry,
      new Set(),
      new Set(),
      () => {},
    )).toThrow('inconsistent admission fencing')

    const sorted = harness()
    for (const [rawId, revision] of [
      ['intent-00000000-0000-4000-8000-000000000234', 2],
      ['intent-00000000-0000-4000-8000-000000000233', 3],
    ] as const) {
      const stale = intent('stage-files', rawId as SakiControlIntentId) as StageFilesIntent
      await sorted.operations.submit({
        ...stale,
        expected: { ...stale.expected, expectedProjectRevision: revision },
      }, actor(), new AbortController().signal)
    }
    for (const [id, record] of sorted.intents.records) {
      sorted.intents.records.set(id, gitOperationIntentRecordSchema.parse({ ...record, createdAt: 1, updatedAt: 1 }))
    }
    expect(validateGitOperationsDurableState(
      sorted.intents,
      sorted.admissions,
      sorted.registry,
      new Set(),
      new Set(),
      () => {},
    ).intents.map(record => record.id)).toEqual([
      'intent-00000000-0000-4000-8000-000000000233',
      'intent-00000000-0000-4000-8000-000000000234',
    ])
  })

  it('rejects cross-kind Intent id reuse and inconsistent admission relations during pure startup validation', () => {
    const test = harness()
    const submitted = intent('stage-files')
    const payload = { intent: submitted, actor: actor() }
    const conflict = gitOperationIntentRecordSchema.parse({
      id: submitted.intentId,
      schemaVersion: 1,
      revision: 0,
      receiptId: submitted.intentId.replace(/^intent-/u, 'receipt-'),
      payloadDigest: canonicalDigest('saki/git-operation-intent/v1', payload),
      payload,
      requestRevision: 0,
      phase: 'conflict',
      terminalReason: 'expected-evidence',
      createdAt: 1,
      updatedAt: 1,
    })
    test.intents.records.set(conflict.id, conflict)
    expect(() => validateGitOperationsDurableState(
      test.intents,
      test.admissions,
      test.registry,
      new Set([conflict.id]),
      new Set(),
      () => {},
    )).toThrow('multiple Intent kinds')
    expect(bindingWriteAdmissionRecordSchema.safeParse({
      id: BINDING_ID,
      schemaVersion: 1,
      revision: 0,
      state: 'agent-run',
      updatedAt: 1,
    }).success).toBe(false)
    expect(bindingWriteAdmissionRecordSchema.safeParse({
      id: BINDING_ID,
      schemaVersion: 1,
      revision: 2,
      state: 'manual-host-operation',
      phase: 'reserved',
      bindingRevision: 0,
      source: { kind: 'control-intent', intentId: conflict.id, intentRevision: 0, payloadDigest: conflict.payloadDigest },
      action: 'project-changes:stage',
      reservedAt: 2,
      updatedAt: 1,
    }).success).toBe(false)
    expect(gitOperationIntentRecordSchema.safeParse({
      ...conflict,
      phase: 'reconciliation-required',
      terminalReason: 'effect-unknown',
    }).success).toBe(false)
  })

  it('ignores irrelevant Host wake-ups and contains a notification recovery failure', async () => {
    const test = harness()
    test.operations.hostChanged({
      operation: {
        id: hostOperationIdSchema.parse('host-operation-00000000-0000-4000-8000-000000000999'),
        hostId: HOST_ID,
        type: 'stage-files',
      },
      revision: 1,
    })
    await test.operations.dispose()

    const completed = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000251' as SakiControlIntentId,
    )
    await expect(test.operations.submit(completed, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true })
    const completedOperation = requiredFakeOperation(test)
    test.operations.hostChanged({ operation: completedOperation.preparation.operation, revision: 3 })
    await test.operations.dispose()

    const recovering = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000252' as SakiControlIntentId,
    )
    await stopAfterPhase(recovering, submitted, 'accepted')
    const operation = requiredFakeOperation(recovering)
    recovering.execution.inspectOperation = () => Promise.reject(new Error('injected notification inspection failure'))
    recovering.operations.hostChanged({ operation: operation.preparation.operation, revision: 1 })
    await expect(recovering.operations.dispose()).resolves.toBeUndefined()
    expect(recovering.intents.get(submitted.intentId)).toMatchObject({ phase: 'accepted' })
  })

  it('reinspects reconciliation and skips evidence-free terminal Intents during initialization', async () => {
    const reconciling = harness()
    reconciling.execution.startMode = 'reconciliation'
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000253' as SakiControlIntentId,
    )
    await reconciling.operations.submit(submitted, actor(), new AbortController().signal)
    const reconciliation = gitOperationIntentRecordSchema.parse(reconciling.intents.get(submitted.intentId))
    const inspectionsBeforeRecovery = reconciling.execution.inspectCount
    await expect(reconciling.operations.initializeValidated({ intents: [reconciliation] })).resolves.toBeUndefined()
    expect(reconciling.execution.inspectCount).toBe(inspectionsBeforeRecovery + 1)
    expect(reconciling.admissions.get(BINDING_ID)).toMatchObject({
      state: 'manual-host-operation',
      source: { intentId: submitted.intentId },
    })

    const terminal = harness()
    const payload = { intent: submitted, actor: actor() }
    const conflict = gitOperationIntentRecordSchema.parse({
      id: submitted.intentId,
      schemaVersion: 1,
      revision: 0,
      receiptId: submitted.intentId.replace(/^intent-/u, 'receipt-'),
      payloadDigest: canonicalDigest('saki/git-operation-intent/v1', payload),
      payload,
      requestRevision: 0,
      phase: 'conflict',
      terminalReason: 'expected-evidence',
      createdAt: 1,
      updatedAt: 1,
    })
    await expect(terminal.operations.initializeValidated({ intents: [conflict] })).resolves.toBeUndefined()
    expect(terminal.execution.inspectCount).toBe(0)
  })

  it.each([
    ['missing', (test: Harness) => { test.admissions.records.delete(BINDING_ID) }],
    ['available', (test: Harness) => { test.admissions.records.set(BINDING_ID, availableAdmission(2)) }],
  ] as const)('keeps an admission-reserved Intent retryable when admission is %s', async (_name, mutate) => {
    const test = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000254' as SakiControlIntentId,
    )
    await stopAfterPhase(test, submitted, 'admission-reserved')
    mutate(test)
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'admission-reserved' },
    })
  })

  it('finishes a terminal prepare replay and rejects a nonterminal prepare replay', async () => {
    const failed = harness()
    const failedIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000255' as SakiControlIntentId,
    )
    const failedController = new AbortController()
    failed.execution.afterPrepare = () => { failedController.abort(new Error('stop after Host prepare')) }
    await expect(failed.operations.submit(failedIntent, actor(), failedController.signal))
      .rejects.toThrow('stop after Host prepare')
    failed.execution.afterPrepare = undefined
    const failedOperation = requiredFakeOperation(failed)
    failedOperation.snapshot = failed.execution.snapshot(failedOperation, {
      state: 'failed',
      admission: { kind: 'not-accepted' },
      completedAt: 12,
      failure: { reason: 'unsupported-state' },
      effect: 'none',
    })
    await expect(failed.operations.submit(failedIntent, actor(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      reason: 'failure',
    })

    const planning = harness()
    const planningIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000256' as SakiControlIntentId,
    )
    const planningController = new AbortController()
    planning.execution.afterPrepare = () => { planningController.abort(new Error('stop after Host prepare')) }
    await expect(planning.operations.submit(planningIntent, actor(), planningController.signal))
      .rejects.toThrow('stop after Host prepare')
    planning.execution.afterPrepare = undefined
    const planningOperation = requiredFakeOperation(planning)
    planningOperation.snapshot = planning.execution.snapshot(planningOperation, {
      state: 'planning',
      admission: { kind: 'accepted', revision: 2, acceptedAt: 11 },
      plannedAt: 12,
    })
    await expect(planning.operations.submit(planningIntent, actor(), new AbortController().signal))
      .rejects.toThrow('Nonterminal Host snapshot cannot finish')
  })

  it.each([
    ['unavailable', 'unavailable'],
    ['source-conflict', 'changed its Host source mapping'],
  ] as const)('handles an accepted prepare replay reporting %s', async (mode, expected) => {
    const test = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000257' as SakiControlIntentId,
    )
    await stopAfterPhase(test, submitted, 'accepted')
    test.execution.prepareMode = mode
    const result = test.operations.submit(submitted, actor(), new AbortController().signal)
    if (mode === 'unavailable') {
      await expect(result).resolves.toMatchObject({ ok: false, reason: expected })
    } else {
      await expect(result).rejects.toThrow(expected)
    }
  })

  it.each([
    ['stage-files', 'intent-00000000-0000-4000-8000-000000000278'],
    ['unstage-files', 'intent-00000000-0000-4000-8000-000000000381'],
    ['create-commit', 'intent-00000000-0000-4000-8000-000000000382'],
  ] as const)('returns an accepted unavailable %s receipt while the Host operation is still planning', async (type, rawId) => {
    const test = harness()
    test.execution.startMode = 'busy-then-succeed-notification'
    await expect(test.operations.submit(
      intent(type, rawId as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { type, state: 'accepted', operation: { state: 'planning' } },
    })
    expect(test.operations.project(BINDING_ID, statusFixture().result, {
      'project-changes:stage': true,
      'project-changes:unstage': true,
      'project-commit:create': true,
    })).toMatchObject({ current: { type, state: 'accepted', operation: { state: 'planning' } } })
  })

  it('retains nonterminal cancellation evidence after Host admission denial and Grant revocation', async () => {
    const denied = harness()
    denied.execution.admissionExpectation = value => ({
      ...value,
      bindingRevision: value.bindingRevision + 1,
    })
    denied.execution.cancelMode = 'nonterminal'
    await expect(denied.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000258' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: false, reason: 'unavailable' })

    const revoked = harness()
    const revokedIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000259' as SakiControlIntentId,
    )
    await stopAfterPhase(revoked, revokedIntent, 'accepted')
    revoked.authority = false
    revoked.execution.cancelMode = 'nonterminal'
    await expect(revoked.operations.submit(revokedIntent, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable' })

    const completed = harness()
    completed.execution.startMode = 'throw-after-success'
    const completedIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000260' as SakiControlIntentId,
    )
    await expect(completed.operations.submit(completedIntent, actor(), new AbortController().signal))
      .rejects.toThrow('start acknowledgement loss')
    completed.authority = false
    await expect(completed.operations.submit(completedIntent, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true })
  })

  it('replays a committed admission acceptance acknowledgement', async () => {
    const test = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000261' as SakiControlIntentId,
    )
    await stopAfterPhase(test, submitted, 'host-prepared')
    const update = test.admissions.update.bind(test.admissions)
    test.admissions.update = async (key, operation) => {
      test.admissions.failAfterCommit = 'update'
      test.admissions.update = update
      return await update(key, operation)
    }
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true })
  })

  it.each([
    ['missing', (test: Harness) => { test.admissions.records.delete(BINDING_ID) }, 'rejects'],
    ['available', (test: Harness) => {
      const current = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(BINDING_ID))
      test.admissions.records.set(BINDING_ID, availableAdmission(current.revision + 1))
    }, 'resolves'],
    ['foreign', (test: Harness) => {
      const current = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(BINDING_ID))
      if (current.state !== 'manual-host-operation') throw new Error('test admission is unavailable')
      test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
        ...current,
        source: {
          ...current.source,
          intentId: 'intent-00000000-0000-4000-8000-000000000299' as SakiControlIntentId,
        },
      }))
    }, 'rejects'],
  ] as const)('handles a %s admission observed immediately before terminal release', async (_name, mutate, outcome) => {
    const test = harness()
    test.execution.afterAdmission = () => { mutate(test) }
    const result = test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000262' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )
    if (outcome === 'resolves') await expect(result).resolves.toMatchObject({ ok: true })
    else await expect(result).rejects.toThrow()
  })

  it.each([
    ['available', (current: Extract<BindingWriteAdmissionRecord, { readonly state: 'manual-host-operation' }>) =>
      availableAdmission(current.revision + 1), true],
    ['newer revision', (current: Extract<BindingWriteAdmissionRecord, { readonly state: 'manual-host-operation' }>) =>
      bindingWriteAdmissionRecordSchema.parse({ ...current, revision: current.revision + 1 }), false],
    ['foreign id', (current: Extract<BindingWriteAdmissionRecord, { readonly state: 'manual-host-operation' }>) =>
      bindingWriteAdmissionRecordSchema.parse({
        ...current,
        source: {
          ...current.source,
          intentId: 'intent-00000000-0000-4000-8000-000000000298' as SakiControlIntentId,
        },
      }), false],
    ['foreign digest', (current: Extract<BindingWriteAdmissionRecord, { readonly state: 'manual-host-operation' }>) =>
      bindingWriteAdmissionRecordSchema.parse({
        ...current,
        source: { ...current.source, payloadDigest: 'f'.repeat(64) },
      }), false],
  ] as const)('fences a terminal release when its CAS callback observes %s', async (_name, concurrent, succeeds) => {
    const test = harness()
    const update = test.admissions.update.bind(test.admissions)
    let releasing = false
    test.execution.afterAdmission = () => { releasing = true }
    test.admissions.update = async (key, operation) => {
      if (!releasing) return await update(key, operation)
      releasing = false
      const current = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(key))
      if (current.state !== 'manual-host-operation') throw new Error('test admission is unavailable')
      const candidate = concurrent(current)
      const next = operation(candidate)
      test.admissions.records.set(key, next)
      return next
    }
    const result = test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000263' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )
    if (succeeds) await expect(result).resolves.toMatchObject({ ok: true })
    else await expect(result).rejects.toThrow()
  })

  it.each([
    ['disappears', (test: Harness, _current: BindingWriteAdmissionRecord) => {
      test.admissions.records.delete(BINDING_ID)
    }],
    ['is replaced by an old available row', (test: Harness, current: BindingWriteAdmissionRecord) => {
      test.admissions.records.set(BINDING_ID, availableAdmission(current.revision))
    }],
  ] as const)('rethrows a terminal release storage failure when admission %s', async (_name, mutate) => {
    const test = harness()
    const update = test.admissions.update.bind(test.admissions)
    let releasing = false
    test.execution.afterAdmission = () => { releasing = true }
    test.admissions.update = async (key, operation) => {
      if (!releasing) return await update(key, operation)
      const current = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(key))
      mutate(test, current)
      void operation
      throw new Error('injected release storage failure')
    }
    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000264' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).rejects.toThrow('injected release storage failure')
  })

  it.each([
    ['preparation operation', (operation: FakeOperation) => {
      Object.assign(operation.preparation.operation, { hostId: OTHER_HOST_ID })
    }, 'Host preparation disagrees'],
    ['snapshot fingerprint', (_operation: FakeOperation, test: Harness) => {
      test.execution.prepareReceiptSnapshot = snapshot => ({
        ...snapshot,
        requestFingerprint: { version: 1, digest: 'f'.repeat(64) },
      })
    }, 'Host snapshot disagrees with its preparation'],
    ['snapshot source', (operation: FakeOperation) => {
      operation.snapshot = {
        ...operation.snapshot,
        source: { ...operation.snapshot.source, payloadDigest: 'f'.repeat(64) },
      } as HostOperationSnapshot
    }, 'Host snapshot disagrees with its Saki Git Intent'],
  ] as const)('rejects a Provider receipt with mismatched %s', async (_name, mutate, message) => {
    const test = harness()
    test.execution.afterPrepare = () => { mutate(requiredFakeOperation(test), test) }
    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000265' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).rejects.toThrow(message)
  })

  it('projects a conflict with retained Host evidence and rejects a mismatched operation kind', async () => {
    for (const [type, rawId] of [
      ['stage-files', 'intent-00000000-0000-4000-8000-000000000266'],
      ['unstage-files', 'intent-00000000-0000-4000-8000-000000000383'],
      ['create-commit', 'intent-00000000-0000-4000-8000-000000000384'],
    ] as const) {
      const conflict = harness()
      const conflictIntent = intent(type, rawId as SakiControlIntentId)
      const prepared = await stopAfterPhase(conflict, conflictIntent, 'host-prepared')
      conflict.intents.records.set(prepared.id, gitOperationIntentRecordSchema.parse({
        ...prepared,
        revision: prepared.revision + 1,
        phase: 'conflict',
        terminalReason: 'source-conflict',
      }))
      await expect(conflict.operations.submit(conflictIntent, actor(), new AbortController().signal))
        .resolves.toMatchObject({
          receipt: { type, state: 'conflict', operation: { type: type === 'create-commit' ? 'commit' : type } },
        })
    }

    const mismatched = harness()
    const mismatchedIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000267' as SakiControlIntentId,
    )
    const accepted = await stopAfterPhase(mismatched, mismatchedIntent, 'accepted')
    const admission = bindingWriteAdmissionRecordSchema.parse(mismatched.admissions.get(BINDING_ID))
    if (accepted.hostRequest === undefined || accepted.preparation === undefined
      || accepted.operationSnapshot === undefined || admission.state !== 'manual-host-operation'
      || admission.phase !== 'accepted') throw new Error('accepted projection fixture is incomplete')
    const operation = { ...accepted.preparation.operation, type: 'unstage-files' as const }
    const preparation = { ...accepted.preparation, operation }
    expect(() => gitOperationIntentRecordSchema.parse({
      ...accepted,
      hostRequest: { ...accepted.hostRequest, type: 'unstage-files' },
      preparation,
      operationSnapshot: { ...accepted.operationSnapshot, operation },
    })).toThrow('Host request kind disagrees with its Intent')
  })

  it('denies the admission callback retained during Host preparation', async () => {
    const test = harness()
    test.execution.probeAdmissionDuringPrepare = true
    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000268' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: true })
    expect(test.execution.prepareAdmissionDecision).toBe('denied')
  })

  it('rejects a malformed admission while resuming its reserved Intent', async () => {
    const test = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000269' as SakiControlIntentId,
    )
    await stopAfterPhase(test, submitted, 'admission-reserved')
    test.admissions.records.set(BINDING_ID, { malformed: true } as never)
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).rejects.toThrow()
  })

  it('fails terminal recovery when admission is absent, orphaned, or has a mismatched digest', async () => {
    const absent = harness()
    const absentIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000270' as SakiControlIntentId,
    )
    await absent.operations.submit(absentIntent, actor(), new AbortController().signal)
    absent.admissions.records.delete(BINDING_ID)
    await expect(absent.operations.submit(absentIntent, actor(), new AbortController().signal)).rejects.toThrow()

    for (const [rawId, mutate] of [
      ['intent-00000000-0000-4000-8000-000000000271', (admission: ReturnType<typeof retainedAcceptedAdmission>) => ({
        ...admission,
        source: {
          ...admission.source,
          intentId: 'intent-00000000-0000-4000-8000-000000000297' as SakiControlIntentId,
        },
      })],
      ['intent-00000000-0000-4000-8000-000000000272', (admission: ReturnType<typeof retainedAcceptedAdmission>) => ({
        ...admission,
        source: { ...admission.source, payloadDigest: 'f'.repeat(64) },
      })],
    ] as const) {
      const test = harness()
      const submitted = intent('stage-files', rawId as SakiControlIntentId)
      await test.operations.submit(submitted, actor(), new AbortController().signal)
      const record = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
      test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse(
        mutate(retainedAcceptedAdmission(record)),
      ))
      await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
        .rejects.toThrow('admission')
    }
  })

  it.each([
    ['disappearing replay', (test: Harness, _owned: ReturnType<typeof retainedAcceptedAdmission>) => {
      test.admissions.records.delete(BINDING_ID)
      throw new Error('injected terminal release failure')
    }, false],
    ['old available replay', (test: Harness, owned: ReturnType<typeof retainedAcceptedAdmission>) => {
      test.admissions.records.set(BINDING_ID, availableAdmission(owned.revision))
      throw new Error('injected terminal release failure')
    }, true],
    ['orphaned replacement', (test: Harness, owned: ReturnType<typeof retainedAcceptedAdmission>) => {
      test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
        ...owned,
        source: {
          ...owned.source,
          intentId: 'intent-00000000-0000-4000-8000-000000000296' as SakiControlIntentId,
        },
      }))
      throw new Error('injected terminal release failure')
    }, false],
  ] as const)('rechecks %s after terminal release failure', async (_name, fail, succeeds) => {
    const test = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000273' as SakiControlIntentId,
    )
    await test.operations.submit(submitted, actor(), new AbortController().signal)
    const record = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    const owned = retainedAcceptedAdmission(record)
    test.admissions.records.set(BINDING_ID, owned)
    test.admissions.update = (_key, _operation) => Promise.resolve(fail(test, owned))
    const result = test.operations.submit(submitted, actor(), new AbortController().signal)
    if (succeeds) await expect(result).resolves.toMatchObject({ ok: true })
    else await expect(result).rejects.toThrow()
  })

  it('retries an admission CAS loss but rethrows a same-owner storage failure during terminal recovery', async () => {
    const retry = harness()
    const retryIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000274' as SakiControlIntentId,
    )
    await retry.operations.submit(retryIntent, actor(), new AbortController().signal)
    const retryRecord = gitOperationIntentRecordSchema.parse(retry.intents.get(retryIntent.intentId))
    retry.admissions.records.set(BINDING_ID, retainedAcceptedAdmission(retryRecord))
    const update = retry.admissions.update.bind(retry.admissions)
    let raced = false
    retry.admissions.update = async (key, operation) => {
      if (raced) return await update(key, operation)
      raced = true
      const current = bindingWriteAdmissionRecordSchema.parse(retry.admissions.get(key))
      const newer = bindingWriteAdmissionRecordSchema.parse({ ...current, revision: current.revision + 1 })
      retry.admissions.records.set(key, newer)
      return operation(newer)
    }
    await expect(retry.operations.submit(retryIntent, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true })

    const failed = harness()
    const failedIntent = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000275' as SakiControlIntentId,
    )
    await failed.operations.submit(failedIntent, actor(), new AbortController().signal)
    const failedRecord = gitOperationIntentRecordSchema.parse(failed.intents.get(failedIntent.intentId))
    failed.admissions.records.set(BINDING_ID, retainedAcceptedAdmission(failedRecord))
    failed.admissions.update = () => Promise.reject(new Error('injected same-owner release failure'))
    await expect(failed.operations.submit(failedIntent, actor(), new AbortController().signal))
      .rejects.toThrow('injected same-owner release failure')
  })

  it('denies a Host admission whose Intent disappears before the callback', async () => {
    const test = harness()
    test.execution.beforeAdmission = () => {
      const current = [...test.intents.records.keys()][0]
      if (current !== undefined) test.intents.records.delete(current)
    }
    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000276' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).rejects.toThrow('missing-key')
  })

  it('preserves an Agent Run owner observed before terminal release and on replay', async () => {
    const test = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000394' as SakiControlIntentId,
    )
    let owner: Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run' }> | undefined
    test.execution.afterAdmission = () => {
      const current = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(BINDING_ID))
      owner = agentRunAdmission(current.revision + 1)
      test.admissions.records.set(BINDING_ID, owner)
    }

    await expect(test.operations.submit(submitted, actor(), new AbortController().signal)).rejects.toThrow()
    expect(owner).toBeDefined()
    await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(test.admissions.get(BINDING_ID)).toEqual(owner)
  })

  it('preserves an Agent Run owner that wins the terminal release update race', async () => {
    const test = harness()
    const submitted = intent(
      'stage-files',
      'intent-00000000-0000-4000-8000-000000000395' as SakiControlIntentId,
    )
    await test.operations.submit(submitted, actor(), new AbortController().signal)
    const record = gitOperationIntentRecordSchema.parse(test.intents.get(submitted.intentId))
    test.admissions.records.set(BINDING_ID, retainedAcceptedAdmission(record))
    let owner: Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run' }> | undefined
    test.admissions.update = async (key, operation) => {
      const current = bindingWriteAdmissionRecordSchema.parse(test.admissions.get(key))
      owner = agentRunAdmission(current.revision + 1)
      test.admissions.records.set(key, owner)
      return operation(owner)
    }

    await expect(test.operations.submit(submitted, actor(), new AbortController().signal))
      .resolves.toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(owner).toBeDefined()
    expect(test.admissions.get(BINDING_ID)).toEqual(owner)
  })

  it('recovers when terminal admission release commits before its acknowledgement', async () => {
    const test = harness()
    test.execution.afterAdmission = () => { test.admissions.failAfterCommit = 'update' }
    await expect(test.operations.submit(
      intent('stage-files', 'intent-00000000-0000-4000-8000-000000000277' as SakiControlIntentId),
      actor(),
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: true })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
  })
})
