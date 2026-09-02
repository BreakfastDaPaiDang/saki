import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'
import {
  bindingWriteAdmissionRecordSchema,
  gitOperationIntentRecordSchema,
  sakiControlPlaneDomainSpec,
  type BindingWriteAdmissionRecord,
  type GitOperationIntentRecord,
  type SakiControlIntentId,
  type SakiDevelopmentProjectId,
  type SakiGrantId,
  type SakiInstallationId,
  type SakiIntentReceiptId,
  type SakiPrincipalId,
  type SakiResourceBindingId,
  type SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import { SAKI_PROJECT_PROJECTION_FIXTURES } from '@breakfastdapaidang/saki-control-plane/src/fixtures.ts'
import {
  canonicalDigest,
  hostOperationRequestSchema,
  hostOperationSnapshotSchema,
  type HostOperationId,
  type HostOperationRequest,
  type HostOperationSnapshot,
  type SakiHostId,
} from '@breakfastdapaidang/saki-execution'
import {
  sakiHostExecutionDomainSpec,
  type LocalHostOperationRecord,
} from '@breakfastdapaidang/saki-execution-local'
import { validateAgentOperationLinks, validateGitOperationLinks } from '../src/state-validation.ts'

const INTENT_ID = 'intent-00000000-0000-4000-8000-000000000071' as SakiControlIntentId
const RECEIPT_ID = 'receipt-00000000-0000-4000-8000-000000000071' as SakiIntentReceiptId
const OPERATION_ID = 'host-operation-00000000-0000-4000-8000-000000000071' as HostOperationId
const PROJECT_ID = 'project-00000000-0000-4000-8000-000000000072' as SakiDevelopmentProjectId
const BINDING_ID = 'binding-00000000-0000-4000-8000-000000000073' as SakiResourceBindingId
const HOST_ID = 'host-00000000-0000-4000-8000-000000000002' as SakiHostId
const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000074' as SakiInstallationId
const STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000075' as SakiStorageGenerationId
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000076' as SakiPrincipalId
const GRANT_ID = 'grant-00000000-0000-4000-8000-000000000077' as SakiGrantId
const CHANGE = {
  id: `git-change-${'1'.repeat(64)}`,
  fingerprint: { version: 1 as const, digest: '2'.repeat(64) },
}
const ALT_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000078' as SakiControlIntentId
const ALT_OPERATION_ID = 'host-operation-00000000-0000-4000-8000-000000000078' as HostOperationId
const ALT_BINDING_ID = 'binding-00000000-0000-4000-8000-000000000078' as SakiResourceBindingId
const TRUSTED_INSPECTION = {
  canonicalWorktreePath: '/fixture/repository',
  canonicalGitDirectory: '/fixture/repository/.git',
  canonicalCommonGitDirectory: '/fixture/repository/.git',
  gitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
  commonGitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
  comparison: { fileMode: true, symlinks: true, autocrlf: false },
}

type GitHostOperationRequest = Exclude<HostOperationRequest, { readonly type: 'start-agent-run' }>

interface LinkedFixture {
  readonly intent: GitOperationIntentRecord
  readonly request: GitHostOperationRequest
  readonly preparation: NonNullable<GitOperationIntentRecord['preparation']>
  readonly preparedSnapshot: HostOperationSnapshot
  readonly operation: LocalHostOperationRecord
  readonly reservedAdmission: BindingWriteAdmissionRecord
  readonly availableAdmission: BindingWriteAdmissionRecord
}

function linkedFixture(requestType: GitHostOperationRequest['type'] = 'stage-files'): LinkedFixture {
  const expectation = {
    projectId: PROJECT_ID,
    expectedRegistryRevision: 1,
    expectedProjectRevision: 0,
    expectedBinding: { id: BINDING_ID, revision: 0 },
    expectedStatus: { version: 1 as const, digest: '5'.repeat(64) },
    expectedHead: { kind: 'commit' as const, objectId: '6'.repeat(40), symbolicRef: 'refs/heads/main' },
    expectedIndex: { kind: 'tree' as const, treeId: '7'.repeat(40) },
    expectedWorktree: { version: 1 as const, digest: '8'.repeat(64) },
  }
  const browserIntent = requestType === 'commit'
    ? {
      type: 'create-commit' as const,
      intentId: INTENT_ID,
      expected: expectation,
      message: 'subject',
    }
    : {
      type: requestType,
      intentId: INTENT_ID,
      expected: expectation,
      changes: [CHANGE],
    }
  const payload = {
    intent: browserIntent,
    actor: {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      hostId: HOST_ID,
      principalId: PRINCIPAL_ID,
      principalRevision: 1,
      grantId: GRANT_ID,
      grantRevision: 1,
    },
  }
  const payloadDigest = canonicalDigest('saki/git-operation-intent/v1', payload)
  const source = { kind: 'control-intent' as const, intentId: INTENT_ID, intentRevision: 0, payloadDigest }
  const expected = {
    binding: {
      id: BINDING_ID,
      revision: 0,
      health: 'active' as const,
      hostId: HOST_ID,
      workspaceId: 'workspace-fixture',
      expectedInspection: {
        projection: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection,
        trusted: TRUSTED_INSPECTION,
      },
      inheritedChangeBaseline: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.baseline,
    },
    status: browserIntent.expected.expectedStatus,
    head: browserIntent.expected.expectedHead,
    index: browserIntent.expected.expectedIndex,
    worktree: browserIntent.expected.expectedWorktree,
    preEffectBaseline: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.baseline,
  }
  const parsedRequest = hostOperationRequestSchema.parse(requestType === 'commit'
    ? { type: requestType, source, expected, message: browserIntent.message }
    : { type: requestType, source, expected, changes: browserIntent.changes })
  if (parsedRequest.type === 'start-agent-run') throw new Error('Git operation fixture parsed as Agent Run')
  const request = parsedRequest
  const requestFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/host-operation-request/v1', request),
  }
  const operation = { id: OPERATION_ID, hostId: HOST_ID, type: requestType }
  const preparation = { operation, preparationRevision: 0, requestFingerprint }
  const preparedSnapshot = hostOperationSnapshotSchema.parse({
    operation,
    revision: 0,
    source: request.source,
    requestFingerprint,
    bindingId: BINDING_ID,
    bindingRevision: 0,
    preparedAt: 2,
    updatedAt: 2,
    state: 'prepared' as const,
    admission: { kind: 'not-accepted' as const },
  })
  const intent = gitOperationIntentRecordSchema.parse({
    id: INTENT_ID,
    schemaVersion: 1,
    revision: 2,
    receiptId: RECEIPT_ID,
    payloadDigest,
    payload,
    requestRevision: 0,
    hostRequest: request,
    phase: 'host-prepared',
    reservationRevision: 1,
    preparation,
    operationSnapshot: preparedSnapshot,
    createdAt: 1,
    updatedAt: 2,
  })
  const operationRecord = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    schemaVersion: 2,
    request,
    preparationRevision: 0,
    snapshot: preparedSnapshot,
  })
  const reservedAdmission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 1,
    state: 'manual-host-operation',
    phase: 'reserved',
    bindingRevision: 0,
    source: request.source,
    action: requestType === 'stage-files'
      ? 'project-changes:stage'
      : requestType === 'unstage-files' ? 'project-changes:unstage' : 'project-commit:create',
    reservedAt: 2,
    updatedAt: 2,
  })
  const availableAdmission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 3,
    state: 'available',
    updatedAt: 4,
  })
  return {
    intent,
    request,
    preparation,
    preparedSnapshot,
    operation: operationRecord,
    reservedAdmission,
    availableAdmission,
  }
}

function sourceConflictIntent(fixture: LinkedFixture): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 2,
    phase: 'conflict',
    reservationRevision: 1,
    preparation: undefined,
    operationSnapshot: undefined,
    terminalReason: 'source-conflict',
    updatedAt: 3,
  })
}

function admissionReservedIntent(fixture: LinkedFixture): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 1,
    phase: 'admission-reserved',
    preparation: undefined,
    operationSnapshot: undefined,
    updatedAt: 2,
  })
}

function preHostConflictIntent(
  fixture: LinkedFixture,
  reason: 'expected-evidence' | 'invalid-selection' = 'expected-evidence',
): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 0,
    hostRequest: undefined,
    phase: 'conflict',
    reservationRevision: undefined,
    preparation: undefined,
    operationSnapshot: undefined,
    terminalReason: reason,
    updatedAt: 1,
  })
}

function preparedIntent(fixture: LinkedFixture): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 0,
    phase: 'prepared',
    reservationRevision: undefined,
    preparation: undefined,
    operationSnapshot: undefined,
    updatedAt: 1,
  })
}

function canceledBeforePreparationIntent(fixture: LinkedFixture): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    phase: 'canceled',
    reservationRevision: undefined,
    preparation: undefined,
    operationSnapshot: undefined,
    terminalReason: 'source-canceled',
    updatedAt: 2,
  })
}

function preparedProtocolConflictIntent(fixture: LinkedFixture): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 3,
    phase: 'conflict',
    terminalReason: 'protocol',
    updatedAt: 3,
  })
}

function preparedOperation(request: GitHostOperationRequest, updatedAt = 2): LocalHostOperationRecord {
  const requestFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/host-operation-request/v1', request),
  }
  return {
    schemaVersion: 2,
    request,
    preparationRevision: 0,
    snapshot: {
      operation: { id: OPERATION_ID, hostId: HOST_ID, type: request.type },
      revision: 0,
      source: request.source,
      requestFingerprint,
      bindingId: BINDING_ID,
      bindingRevision: 0,
      preparedAt: 2,
      updatedAt,
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    } as HostOperationSnapshot,
  }
}

function mismatchedOperation(fixture: LinkedFixture): LocalHostOperationRecord {
  const request = hostOperationRequestSchema.parse({
    ...fixture.request,
    expected: {
      ...fixture.request.expected,
      status: { version: 1, digest: '9'.repeat(64) },
    },
  })
  if (request.type === 'start-agent-run') throw new Error('Git operation fixture parsed as Agent Run')
  return preparedOperation(request)
}

function canceledFixture(fixture: LinkedFixture): {
  readonly intent: GitOperationIntentRecord
  readonly operation: LocalHostOperationRecord
} {
  const snapshot = {
    ...fixture.preparedSnapshot,
    revision: 1,
    updatedAt: 4,
    state: 'canceled' as const,
    admission: { kind: 'accepted' as const, revision: 2, acceptedAt: 3 },
    completedAt: 4,
    reason: 'authority-revoked' as const,
    effect: 'none' as const,
  }
  const intent = gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 4,
    phase: 'canceled',
    admissionRevision: 2,
    operationSnapshot: snapshot,
    terminalReason: 'authority-revoked',
    updatedAt: 4,
  })
  return {
    intent,
    operation: { ...fixture.operation, snapshot },
  }
}

function acceptedFixture(fixture: LinkedFixture): {
  readonly intent: GitOperationIntentRecord
  readonly operation: LocalHostOperationRecord
  readonly admission: BindingWriteAdmissionRecord
} {
  const snapshot = {
    ...fixture.preparedSnapshot,
    revision: 1,
    updatedAt: 3,
    state: 'accepted' as const,
    admission: { kind: 'accepted' as const, revision: 2, acceptedAt: 3 },
  }
  return {
    intent: gitOperationIntentRecordSchema.parse({
      ...fixture.intent,
      revision: 3,
      phase: 'accepted',
      admissionRevision: 2,
      operationSnapshot: snapshot,
      updatedAt: 3,
    }),
    operation: { ...fixture.operation, snapshot },
    admission: bindingWriteAdmissionRecordSchema.parse({
      ...fixture.reservedAdmission,
      revision: 2,
      phase: 'accepted',
      preparation: fixture.preparation,
      acceptedAt: 3,
      updatedAt: 3,
    }),
  }
}

function domains(
  intents: readonly GitOperationIntentRecord[],
  operations: readonly LocalHostOperationRecord[],
  admissions: readonly BindingWriteAdmissionRecord[],
): readonly [Domain<typeof sakiControlPlaneDomainSpec>, Domain<typeof sakiHostExecutionDomainSpec>] {
  return domainsFromEntries(
    intents.map(intent => [intent.id, intent] as const),
    operations.map(operation => [operation.snapshot.operation.id, operation] as const),
    admissions.map(admission => [admission.id, admission] as const),
  )
}

function domainsFromEntries(
  intents: readonly (readonly [string, GitOperationIntentRecord])[],
  operations: readonly (readonly [string, LocalHostOperationRecord])[],
  admissions: readonly (readonly [string, BindingWriteAdmissionRecord])[],
): readonly [Domain<typeof sakiControlPlaneDomainSpec>, Domain<typeof sakiHostExecutionDomainSpec>] {
  const controlTables = new Map<string, ReturnType<typeof readonlyTable>>([
    ['git_operation_intents', readonlyTable(intents)],
    ['agent_runs', readonlyTable([])],
    ['execution_dispatches', readonlyTable([])],
    ['binding_write_admissions', readonlyTable(admissions)],
  ])
  const operationTable = readonlyTable(operations)
  const controlPlane = {
    name: sakiControlPlaneDomainSpec.name,
    table: (name: string) => controlTables.get(name),
    close: () => Promise.resolve(),
  } as unknown as Domain<typeof sakiControlPlaneDomainSpec>
  const hostExecution = {
    name: sakiHostExecutionDomainSpec.name,
    table: () => operationTable,
    close: () => Promise.resolve(),
  } as unknown as Domain<typeof sakiHostExecutionDomainSpec>
  return [controlPlane, hostExecution]
}

function readonlyTable(entries: readonly (readonly [string, unknown])[]) {
  const records = new Map(entries)
  return {
    get size() { return records.size },
    get: (key: string) => records.get(key),
    entries: () => new Map(records).entries(),
    keys: () => new Map(records).keys(),
  }
}

describe('current Saki Git-operation cross-domain validation', () => {
  it('is ignored by Agent-operation validation', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains([], [fixture.operation], [])

    expect(() => { validateAgentOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts a reserved Intent with the prepared, not-accepted Host Operation from a safe crash gap', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains(
      [admissionReservedIntent(fixture)],
      [fixture.operation],
      [fixture.reservedAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('rejects an orphan Host Operation', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains([], [fixture.operation], [fixture.availableAdmission])

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki Host Operation has no Control Intent')
  })

  it('rejects durable identities that disagree with their table keys or source-derived id', () => {
    const fixture = linkedFixture()
    const operationWithAnotherId = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      ...fixture.operation,
      snapshot: {
        ...fixture.operation.snapshot,
        operation: { ...fixture.operation.snapshot.operation, id: ALT_OPERATION_ID },
      },
    })
    const cases = [
      {
        message: 'Saki Git operation Intent id disagrees with its table key',
        subjects: domainsFromEntries([[ALT_INTENT_ID, fixture.intent]], [], []),
      },
      {
        message: 'Saki Binding write admission id disagrees with its table key',
        subjects: domainsFromEntries([], [], [[ALT_BINDING_ID, fixture.availableAdmission]]),
      },
      {
        message: 'Saki Host Operation id disagrees with its table key',
        subjects: domainsFromEntries(
          [[fixture.intent.id, fixture.intent]],
          [[ALT_OPERATION_ID, fixture.operation]],
          [[fixture.reservedAdmission.id, fixture.reservedAdmission]],
        ),
      },
      {
        message: 'Saki Host Operation id disagrees with its Control Intent source',
        subjects: domainsFromEntries(
          [[fixture.intent.id, fixture.intent]],
          [[ALT_OPERATION_ID, operationWithAnotherId]],
          [[fixture.reservedAdmission.id, fixture.reservedAdmission]],
        ),
      },
    ] as const

    for (const { message, subjects: [controlPlane, hostExecution] } of cases) {
      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).toThrow(message)
    }
  })

  it('rejects prepared Intent evidence after its Host Operation disappears', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains(
      [fixture.intent],
      [],
      [fixture.reservedAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki Git operation Intent preparation has no Host Operation')
  })

  it('rejects a source conflict without the existing mismatched Host Operation that caused it', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains(
      [sourceConflictIntent(fixture)],
      [],
      [fixture.availableAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('source-conflicted Git Intent has no Host Operation')
  })

  it('accepts a source conflict only when its existing Host Operation has a mismatched safe request', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains(
      [sourceConflictIntent(fixture)],
      [mismatchedOperation(fixture)],
      [fixture.availableAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('rejects a source conflict that still matches its Host Operation request', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains(
      [sourceConflictIntent(fixture)],
      [fixture.operation],
      [fixture.availableAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki source-conflicted Git Intent unexpectedly matches its Host Operation')
  })

  it('rejects a source conflict whose mismatched Host Operation was admitted', () => {
    const fixture = linkedFixture()
    const mismatched = mismatchedOperation(fixture)
    const admitted = {
      ...mismatched,
      snapshot: {
        ...mismatched.snapshot,
        revision: 1,
        updatedAt: 3,
        state: 'accepted' as const,
        admission: { kind: 'accepted' as const, revision: 2, acceptedAt: 3 },
      },
    }
    const [controlPlane, hostExecution] = domains(
      [sourceConflictIntent(fixture)],
      [admitted],
      [fixture.availableAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki source-conflicted Git Intent points to an admitted or possible-effect Host Operation')
  })

  it('rejects an accepted Binding admission whose preparation disagrees with the Host Operation', () => {
    const fixture = linkedFixture()
    const admission = bindingWriteAdmissionRecordSchema.parse({
      ...fixture.reservedAdmission,
      revision: 2,
      phase: 'accepted',
      preparation: { ...fixture.preparation, preparationRevision: 1 },
      acceptedAt: 3,
      updatedAt: 3,
    })
    const [controlPlane, hostExecution] = domains([fixture.intent], [fixture.operation], [admission])

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki Host Operation disagrees with its Binding write admission')
  })

  it('rejects an accepted Binding admission whose Binding revision disagrees with the Host request', () => {
    const fixture = linkedFixture()
    const admission = bindingWriteAdmissionRecordSchema.parse({
      ...fixture.reservedAdmission,
      revision: 2,
      phase: 'accepted',
      bindingRevision: 1,
      preparation: fixture.preparation,
      acceptedAt: 3,
      updatedAt: 3,
    })
    const [controlPlane, hostExecution] = domains([fixture.intent], [fixture.operation], [admission])

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki Host Operation disagrees with its Binding write admission')
  })

  it('rejects different retained and current Host snapshots at the same revision', () => {
    const fixture = linkedFixture()
    const changed = preparedOperation(fixture.request, 3)
    const [controlPlane, hostExecution] = domains(
      [fixture.intent],
      [changed],
      [fixture.reservedAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki Git operation Intent disagrees with the same Host Operation revision')
  })

  it('rejects mismatched preparation, future retained evidence, and lagging terminal evidence', () => {
    const fixture = linkedFixture()
    const preparationMismatch = {
      ...fixture.operation,
      preparationRevision: fixture.operation.preparationRevision + 1,
    }
    const futureIntent = gitOperationIntentRecordSchema.parse({
      ...fixture.intent,
      operationSnapshot: { ...fixture.preparedSnapshot, revision: 1 },
    })
    const terminal = canceledFixture(fixture)
    const advancedTerminalOperation = {
      ...terminal.operation,
      snapshot: { ...terminal.operation.snapshot, revision: terminal.operation.snapshot.revision + 1 },
    }
    for (const [intent, operation, admission, message] of [
      [
        fixture.intent,
        preparationMismatch,
        fixture.reservedAdmission,
        'Saki Git operation Intent preparation disagrees with its Host Operation',
      ],
      [
        futureIntent,
        fixture.operation,
        fixture.reservedAdmission,
        'Saki Git operation Intent retains a future Host Operation revision',
      ],
      [
        terminal.intent,
        advancedTerminalOperation,
        fixture.availableAdmission,
        'terminal Saki Git operation Intent lags its Host Operation',
      ],
    ] as const) {
      const [controlPlane, hostExecution] = domains([intent], [operation], [admission])
      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).toThrow(message)
    }
  })

  it.each(['stage-files', 'unstage-files', 'commit'] as const)(
    'accepts one fully linked accepted %s operation',
    (type) => {
      const accepted = acceptedFixture(linkedFixture(type))
      const [controlPlane, hostExecution] = domains(
        [accepted.intent],
        [accepted.operation],
        [accepted.admission],
      )

      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).not.toThrow()
    },
  )

  it('rejects lost or revision-mismatched current write admissions', () => {
    const fixture = linkedFixture()
    const accepted = acceptedFixture(fixture)
    const acceptedFromPreparedIntent = gitOperationIntentRecordSchema.parse({
      ...fixture.intent,
      revision: 3,
      phase: 'accepted',
      admissionRevision: 1,
      updatedAt: 3,
    })
    const wrongAdmissionRevision = bindingWriteAdmissionRecordSchema.parse({
      ...accepted.admission,
      revision: 3,
    })
    for (const [intent, operation, admission, message] of [
      [
        fixture.intent,
        fixture.operation,
        fixture.availableAdmission,
        'nonterminal Saki Host Operation lost its Binding write admission',
      ],
      [
        acceptedFromPreparedIntent,
        accepted.operation,
        accepted.admission,
        'accepted Saki Host Operation disagrees with its Control Intent admission',
      ],
      [
        accepted.intent,
        accepted.operation,
        wrongAdmissionRevision,
        'accepted Saki Host Operation disagrees with its Binding write admission',
      ],
      [
        accepted.intent,
        accepted.operation,
        fixture.reservedAdmission,
        'nonterminal accepted Saki Host Operation lost its Binding write admission',
      ],
    ] as const) {
      const [controlPlane, hostExecution] = domains([intent], [operation], [admission])
      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).toThrow(message)
    }
  })

  it('accepts released admission after both the Host Operation and Intent are terminal', () => {
    const fixture = linkedFixture()
    const terminal = canceledFixture(fixture)
    const [controlPlane, hostExecution] = domains(
      [terminal.intent],
      [terminal.operation],
      [fixture.availableAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts a cancellation recovered before preparation and rejects other unexplained pre-preparation records', () => {
    const fixture = linkedFixture()
    const [canceledControl, canceledHost] = domains(
      [canceledBeforePreparationIntent(fixture)],
      [fixture.operation],
      [fixture.availableAdmission],
    )
    expect(() => { validateGitOperationLinks(canceledControl, canceledHost) }).not.toThrow()

    const failedOperation = {
      ...fixture.operation,
      snapshot: {
        ...fixture.preparedSnapshot,
        revision: 1,
        updatedAt: 3,
        state: 'failed' as const,
        completedAt: 3,
        failure: { reason: 'unsupported-state' as const },
        effect: 'none' as const,
      },
    }
    for (const [intent, operation] of [
      [preparedIntent(fixture), fixture.operation],
      [admissionReservedIntent(fixture), failedOperation],
    ] as const) {
      const [controlPlane, hostExecution] = domains([intent], [operation], [fixture.reservedAdmission])
      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
        .toThrow('Saki Control Intent has an unexplained pre-preparation Host Operation')
    }
  })

  it('rejects every broken accepted-admission back-link after operation validation', () => {
    const fixture = linkedFixture()
    const accepted = acceptedFixture(fixture)
    const sourceConflict = sourceConflictIntent(fixture)
    const protocolConflict = preparedProtocolConflictIntent(fixture)
    const admissionForMissingIntent = bindingWriteAdmissionRecordSchema.parse({
      ...accepted.admission,
      source: {
        kind: 'control-intent',
        intentId: ALT_INTENT_ID,
        intentRevision: fixture.request.source.intentRevision,
        payloadDigest: fixture.request.source.payloadDigest,
      },
    })
    const admissionWithNoOperationBinding = bindingWriteAdmissionRecordSchema.parse({
      ...accepted.admission,
      id: ALT_BINDING_ID,
    })
    const admissionWithWrongPreparation = bindingWriteAdmissionRecordSchema.parse({
      ...admissionWithNoOperationBinding,
      preparation: {
        ...fixture.preparation,
        preparationRevision: fixture.preparation.preparationRevision + 1,
      },
    })
    const cases = [
      domains([preHostConflictIntent(fixture)], [], [accepted.admission]),
      domains([canceledFixture(fixture).intent], [canceledFixture(fixture).operation], [admissionForMissingIntent]),
      domains([sourceConflict], [mismatchedOperation(fixture)], [accepted.admission]),
      domains([admissionReservedIntent(fixture)], [fixture.operation], [accepted.admission]),
      domains([protocolConflict], [fixture.operation], [admissionWithWrongPreparation]),
      domains([protocolConflict], [fixture.operation], [admissionWithNoOperationBinding]),
    ] as const

    for (const [controlPlane, hostExecution] of cases) {
      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
        .toThrow('Saki accepted Binding write admission has no matching Host Operation')
    }
  })

  it.each(['expected-evidence', 'invalid-selection'] as const)(
    'accepts a pre-Host %s conflict only while no Host Operation exists',
    (reason) => {
      const fixture = linkedFixture()
      const conflict = preHostConflictIntent(fixture, reason)
      const [withoutControl, withoutHost] = domains([conflict], [], [fixture.availableAdmission])
      expect(() => { validateGitOperationLinks(withoutControl, withoutHost) }).not.toThrow()

      const [withControl, withHost] = domains([conflict], [fixture.operation], [fixture.availableAdmission])
      expect(() => { validateGitOperationLinks(withControl, withHost) })
        .toThrow('Saki Host Operation request disagrees with its Control Intent')
    },
  )
})
