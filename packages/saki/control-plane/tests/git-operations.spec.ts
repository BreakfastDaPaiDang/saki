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
  HostOperationAcceptance,
  SakiHostExecution,
} from '@breakfastdapaidang/saki-execution'
import type {
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
const BINDING_ID = PROJECT.binding.id
const HOST_ID = PROJECT.binding.hostId
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
  failAfterCommit: 'put' | 'update' | undefined

  constructor(entries: readonly (readonly [K, V])[] = []) {
    for (const [key, value] of entries) this.records.set(key, value)
  }

  get size(): number { return this.records.size }
  get(key: K): V | undefined { return this.records.get(key) }
  entries(): IterableIterator<[K, V]> { return new Map(this.records).entries() }
  keys(): IterableIterator<K> { return new Map(this.records).keys() }

  async put(key: K, value: V): Promise<void> {
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
  readonly request: HostOperationRequest
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
  startCount = 0
  cancelCount = 0
  beforePrepare: (() => Promise<void>) | undefined
  afterPrepare: (() => void) | undefined
  beforeAdmission: (() => void) | undefined
  startMode:
    | 'succeed'
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

  async inspectProject(): Promise<InspectProjectResult> { return this.inspectResult }
  async readDiff(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
    return { ok: false, reason: 'unavailable' }
  }

  async prepareOperation<K extends HostOperationKind>(
    request: HostOperationRequest<K>,
    admission: HostOperationAdmissionSource,
  ): Promise<HostOperationReceipt<K>> {
    this.prepareCount += 1
    await this.beforePrepare?.()
    const existing = [...this.operations.values()].find(candidate =>
      candidate.request.source.intentId === request.source.intentId)
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
      id: `host-operation-${String(request.source.intentId).slice('intent-'.length)}`,
      hostId: request.expected.binding.hostId,
      type: request.type,
    } as HostOperationReference<K>
    const preparation = {
      operation,
      preparationRevision: 0,
      requestFingerprint: {
        version: 1 as const,
        digest: canonicalDigest('saki/test-host-request/v1', request),
      },
    }
    const snapshot = {
      operation,
      revision: 0,
      source: request.source,
      requestFingerprint: preparation.requestFingerprint,
      bindingId: request.expected.binding.id,
      bindingRevision: request.expected.binding.revision,
      preparedAt: 10,
      updatedAt: 10,
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    } as HostOperationSnapshot<K>
    const stored: FakeOperation = {
      request,
      admission,
      preparation,
      acceptance: new TestAcceptance(operation.id),
      snapshot,
    }
    this.operations.set(operation.id, stored)
    this.afterPrepare?.()
    return {
      ok: true,
      preparation,
      snapshot,
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
    if (stored.acceptance !== acceptance) {
      return { ok: false, reason: 'acceptance-mismatch', snapshot: stored.snapshot as HostOperationSnapshot<K> }
    }
    this.beforeAdmission?.()
    const decision = await stored.admission({
      bindingId: stored.request.expected.binding.id,
      bindingRevision: stored.request.expected.binding.revision,
      preparation: stored.preparation,
      source: stored.request.source,
    }, signal)
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
    stored.snapshot = this.success(stored, decision.admissionRevision, 1)
    this.emit(stored.snapshot)
    if (this.startMode === 'throw-after-success') throw new Error('injected start acknowledgement loss')
    return { ok: true, snapshot: stored.snapshot as HostOperationSnapshot<K> }
  }

  async inspectOperation<K extends HostOperationKind>(
    operation: HostOperationReference<K>,
  ): Promise<HostOperationSnapshot<K>> {
    return this.required(operation).snapshot as HostOperationSnapshot<K>
  }

  async cancelOperation<K extends HostOperationKind>(
    operation: HostOperationReference<K>,
    reason: HostOperationCancellationReason,
  ): Promise<HostOperationSnapshot<K>> {
    this.cancelCount += 1
    const stored = this.required(operation)
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

  private snapshot(stored: FakeOperation, state: object): HostOperationSnapshot {
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
  const state = { authority: true, bindingCurrent: true }
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
        ? fixture.resolved
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
    schemaVersion: 1,
    revision: 1,
    projects: [{
      id: PROJECT_ID,
      revision: 0,
      projectTitle: 'Fixture project',
      resourceBindingId: BINDING_ID,
      state: 'active',
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

describe('Saki structured Git operations', () => {
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
})
