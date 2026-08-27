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
  type HostOperationId,
  type HostOperationRequest,
  type HostOperationSnapshot,
  type SakiHostId,
} from '@breakfastdapaidang/saki-execution'
import {
  sakiHostExecutionDomainSpec,
  type LocalHostOperationRecord,
} from '@breakfastdapaidang/saki-execution-local'
import { validateGitOperationLinks } from '../src/state-validation.ts'

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
const TRUSTED_INSPECTION = {
  canonicalWorktreePath: '/fixture/repository',
  canonicalGitDirectory: '/fixture/repository/.git',
  canonicalCommonGitDirectory: '/fixture/repository/.git',
  gitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
  commonGitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
  comparison: { fileMode: true, symlinks: true, autocrlf: false },
}

interface LinkedFixture {
  readonly intent: GitOperationIntentRecord
  readonly request: HostOperationRequest
  readonly preparation: NonNullable<GitOperationIntentRecord['preparation']>
  readonly preparedSnapshot: HostOperationSnapshot
  readonly operation: LocalHostOperationRecord
  readonly reservedAdmission: BindingWriteAdmissionRecord
  readonly availableAdmission: BindingWriteAdmissionRecord
}

function linkedFixture(): LinkedFixture {
  const browserIntent = {
    type: 'stage-files' as const,
    intentId: INTENT_ID,
    expected: {
      projectId: PROJECT_ID,
      expectedRegistryRevision: 1,
      expectedProjectRevision: 0,
      expectedBinding: { id: BINDING_ID, revision: 0 },
      expectedStatus: { version: 1 as const, digest: '5'.repeat(64) },
      expectedHead: { kind: 'commit' as const, objectId: '6'.repeat(40), symbolicRef: 'refs/heads/main' },
      expectedIndex: { kind: 'tree' as const, treeId: '7'.repeat(40) },
      expectedWorktree: { version: 1 as const, digest: '8'.repeat(64) },
    },
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
  const request = hostOperationRequestSchema.parse({
    type: 'stage-files',
    source: { kind: 'control-intent', intentId: INTENT_ID, intentRevision: 0, payloadDigest },
    expected: {
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
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
    },
    changes: browserIntent.changes,
  })
  const requestFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/host-operation-request/v1', request),
  }
  const operation = { id: OPERATION_ID, hostId: HOST_ID, type: 'stage-files' as const }
  const preparation = { operation, preparationRevision: 0, requestFingerprint }
  const preparedSnapshot = {
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
  }
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
  const operationRecord = {
    schemaVersion: 1 as const,
    request,
    preparationRevision: 0,
    snapshot: preparedSnapshot,
  }
  const reservedAdmission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 1,
    state: 'manual-host-operation',
    phase: 'reserved',
    bindingRevision: 0,
    source: request.source,
    action: 'project-changes:stage',
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

function preparedOperation(request: HostOperationRequest, updatedAt = 2): LocalHostOperationRecord {
  const requestFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/host-operation-request/v1', request),
  }
  return {
    schemaVersion: 1,
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

function domains(
  intents: readonly GitOperationIntentRecord[],
  operations: readonly LocalHostOperationRecord[],
  admissions: readonly BindingWriteAdmissionRecord[],
): readonly [Domain<typeof sakiControlPlaneDomainSpec>, Domain<typeof sakiHostExecutionDomainSpec>] {
  const controlTables = new Map<string, ReturnType<typeof readonlyTable>>([
    ['git_operation_intents', readonlyTable(intents.map(intent => [intent.id, intent] as const))],
    ['binding_write_admissions', readonlyTable(admissions.map(admission => [admission.id, admission] as const))],
  ])
  const operationTable = readonlyTable(operations.map(operation => [operation.snapshot.operation.id, operation] as const))
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
