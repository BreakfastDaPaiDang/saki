import { describe, expect, it, vi } from 'vitest'
import {
  canonicalDigest,
  MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES,
  MAX_HOST_OPERATION_SELECTED_CHANGES,
} from '@breakfastdapaidang/saki-execution'
import {
  SAKI_GIT_REQUEST_FIXTURES,
  SAKI_PROJECT_PROJECTION_FIXTURES,
} from '../src/fixtures.ts'
import {
  bindingWriteAdmissionRecordSchema,
  bindingWriteAdmissionV2RecordSchema,
  createCommitIntentSchema,
  gitOperationIntentRecordSchema,
  stageFilesIntentSchema,
} from '../src/spec.ts'

const intent = SAKI_GIT_REQUEST_FIXTURES.stage
const project = SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace.project
const currentSelection = SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace.currentSelection
const actor = {
  installationId: 'installation-00000000-0000-4000-8000-000000000021',
  storageGenerationId: 'storage-generation-00000000-0000-4000-8000-000000000022',
  hostId: project.binding.hostId,
  principalId: 'principal-00000000-0000-4000-8000-000000000023',
  principalRevision: 1,
  grantId: 'grant-00000000-0000-4000-8000-000000000024',
  grantRevision: 1,
} as const
const payload = { intent, actor } as const
const payloadDigest = canonicalDigest('saki/git-operation-intent/v1', payload)
const source = {
  kind: 'control-intent',
  intentId: intent.intentId,
  intentRevision: 0,
  payloadDigest,
} as const
const trusted = {
  canonicalWorktreePath: '/fixture/repository',
  canonicalGitDirectory: '/fixture/repository/.git',
  canonicalCommonGitDirectory: '/fixture/repository/.git',
  gitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
  commonGitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
  comparison: { fileMode: true, symlinks: true, autocrlf: false },
} as const
const hostRequest = {
  type: 'stage-files',
  source,
  expected: {
    binding: {
      id: intent.expected.expectedBinding.id,
      revision: intent.expected.expectedBinding.revision,
      health: 'active',
      hostId: actor.hostId,
      workspaceId: currentSelection.workspaceId,
      expectedInspection: {
        projection: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection,
        trusted,
      },
      inheritedChangeBaseline: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.baseline,
    },
    status: intent.expected.expectedStatus,
    head: intent.expected.expectedHead,
    index: intent.expected.expectedIndex,
    worktree: intent.expected.expectedWorktree,
    preEffectBaseline: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.baseline,
  },
  changes: intent.changes,
} as const
const operation = {
  id: 'host-operation-00000000-0000-4000-8000-000000000010',
  hostId: actor.hostId,
  type: 'stage-files',
} as const
const preparation = {
  operation,
  preparationRevision: 0,
  requestFingerprint: { version: 1, digest: '7'.repeat(64) },
} as const
const snapshotBase = {
  operation,
  revision: 0,
  source,
  requestFingerprint: preparation.requestFingerprint,
  bindingId: intent.expected.expectedBinding.id,
  bindingRevision: intent.expected.expectedBinding.revision,
  preparedAt: 2,
  updatedAt: 6,
} as const
const preparedSnapshot = {
  ...snapshotBase,
  state: 'prepared',
  admission: { kind: 'not-accepted' },
} as const
const acceptedSnapshot = {
  ...snapshotBase,
  state: 'accepted',
  admission: { kind: 'accepted', revision: 2, acceptedAt: 3 },
} as const
const planningSnapshot = {
  ...snapshotBase,
  state: 'planning',
  admission: { kind: 'accepted', revision: 2, acceptedAt: 3 },
  plannedAt: 4,
} as const
const publishingSnapshot = {
  ...snapshotBase,
  state: 'publishing',
  admission: { kind: 'accepted', revision: 2, acceptedAt: 3 },
  plannedAt: 4,
  effectPlannedAt: 5,
  publishingAt: 5,
} as const
const succeededSnapshot = {
  ...snapshotBase,
  state: 'succeeded',
  admission: { kind: 'accepted', revision: 2, acceptedAt: 3 },
  completedAt: 6,
  result: {
    type: 'stage-files',
    changes: intent.changes.map((change, index) => ({ ...change, path: `selected-${index}.txt` })),
    resultingIndex: intent.expected.expectedIndex,
  },
} as const
const failedSnapshot = {
  ...snapshotBase,
  state: 'failed',
  admission: { kind: 'accepted', revision: 2, acceptedAt: 3 },
  completedAt: 6,
  failure: { reason: 'unsupported-state' },
  effect: 'none',
} as const
const failedBeforeAdmissionSnapshot = {
  ...snapshotBase,
  state: 'failed',
  admission: { kind: 'not-accepted' },
  completedAt: 6,
  failure: { reason: 'invalid-selection' },
  effect: 'none',
} as const
const canceledSnapshot = {
  ...snapshotBase,
  state: 'canceled',
  admission: { kind: 'accepted', revision: 2, acceptedAt: 3 },
  completedAt: 6,
  reason: 'authority-revoked',
  effect: 'none',
} as const
const reconciliationSnapshot = {
  ...snapshotBase,
  state: 'reconciliation-required',
  admission: { kind: 'accepted', revision: 2, acceptedAt: 3 },
  observedAt: 6,
  reason: 'effect-unknown',
} as const

function record(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: intent.intentId,
    schemaVersion: 1,
    revision: 0,
    receiptId: String(intent.intentId).replace(/^intent-/u, 'receipt-'),
    payloadDigest,
    payload,
    requestRevision: 0,
    hostRequest,
    phase: 'prepared',
    createdAt: 1,
    updatedAt: 6,
    ...overrides,
  }
}

function hostEvidence(
  phase: string,
  operationSnapshot: Readonly<Record<string, unknown>>,
  admissionRevision: number | null = 2,
) {
  return record({
    phase,
    reservationRevision: 1,
    preparation,
    ...(admissionRevision === null ? {} : { admissionRevision }),
    operationSnapshot,
  })
}

function expectGitIssue(value: unknown, message: string): void {
  const result = gitOperationIntentRecordSchema.safeParse(value)
  expect(result.success).toBe(false)
  if (result.success) throw new Error('invalid Git Intent fixture unexpectedly parsed')
  expect(result.error.issues.map(issue => issue.message)).toContain(message)
}

function expectAdmissionIssue(value: unknown, message: string): void {
  const result = bindingWriteAdmissionRecordSchema.safeParse(value)
  expect(result.success).toBe(false)
  if (result.success) throw new Error('invalid write admission fixture unexpectedly parsed')
  expect(result.error.issues.map(issue => issue.message)).toContain(message)
}

describe('structured Git durable schemas', () => {
  it('rejects an oversized raw durable selection before reading an element', () => {
    const changes: unknown[] = []
    changes.length = MAX_HOST_OPERATION_SELECTED_CHANGES + 1
    let elementReads = 0
    Object.defineProperty(changes, '0', {
      configurable: true,
      get() {
        elementReads += 1
        throw new Error('durable selection limit read an element')
      },
    })

    const result = stageFilesIntentSchema.safeParse({ ...intent, changes })

    expect(elementReads).toBe(0)
    expect(result.success).toBe(false)
  })

  it('rejects all-zero durable expected index object ids in either Git object format', () => {
    for (const width of [40, 64] as const) {
      expect(stageFilesIntentSchema.safeParse({
        ...intent,
        expected: {
          ...intent.expected,
          expectedHead: { ...intent.expected.expectedHead, objectId: '6'.repeat(width) },
          expectedIndex: { kind: 'tree', treeId: '0'.repeat(width) },
        },
      }).success).toBe(false)
    }
  })

  it('rejects durable expected HEAD and index object ids with different widths', () => {
    for (const [headWidth, indexWidth] of [[40, 64], [64, 40]] as const) {
      expect(stageFilesIntentSchema.safeParse({
        ...intent,
        expected: {
          ...intent.expected,
          expectedHead: { ...intent.expected.expectedHead, objectId: '6'.repeat(headWidth) },
          expectedIndex: { kind: 'tree', treeId: '7'.repeat(indexWidth) },
        },
      }).success).toBe(false)
    }
  })

  it('rejects an oversized raw durable Commit message before UTF-8 encoding', () => {
    const commitIntent = SAKI_GIT_REQUEST_FIXTURES.commit
    const message = 'a'.repeat(MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES + 1)
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    try {
      const result = createCommitIntentSchema.safeParse({ ...commitIntent, message })

      expect(encode.mock.calls.some(([value]) => value === message)).toBe(false)
      expect(result.success).toBe(false)

      const multibyteMessage = '\u0800'.repeat(
        Math.floor(MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES / 3) + 1,
      )
      const multibyteResult = createCommitIntentSchema.safeParse({
        ...commitIntent,
        message: multibyteMessage,
      })
      expect(encode.mock.calls.some(([value]) => value === multibyteMessage)).toBe(true)
      expect(multibyteResult.success).toBe(false)
    } finally {
      encode.mockRestore()
    }
  })

  it('accepts every recoverable Git Intent lifecycle evidence form', () => {
    const records: Array<Record<string, unknown>> = [
      record({
        hostRequest: undefined,
        phase: 'conflict',
        terminalReason: 'expected-evidence',
      }),
      record({
        hostRequest: undefined,
        phase: 'conflict',
        terminalReason: 'invalid-selection',
      }),
      record(),
      record({ phase: 'admission-reserved', reservationRevision: 1 }),
      hostEvidence('host-prepared', preparedSnapshot, null),
      hostEvidence('accepted', preparedSnapshot),
      hostEvidence('accepted', acceptedSnapshot),
      hostEvidence('accepted', planningSnapshot),
      hostEvidence('accepted', publishingSnapshot),
      hostEvidence('succeeded', succeededSnapshot),
      record({ phase: 'conflict', terminalReason: 'source-conflict' }),
      hostEvidence('conflict', preparedSnapshot, null),
      hostEvidence('failed', failedSnapshot, 2),
      hostEvidence('failed', failedBeforeAdmissionSnapshot, null),
      record({ phase: 'canceled', terminalReason: 'source-canceled' }),
      hostEvidence('canceled', canceledSnapshot, 2),
      hostEvidence('reconciliation-required', reconciliationSnapshot, 2),
    ]
    records[11] = { ...records[11], terminalReason: 'protocol' }
    records[12] = { ...records[12], terminalReason: 'unsupported-state' }
    records[13] = { ...records[13], terminalReason: 'invalid-selection' }
    records[15] = { ...records[15], terminalReason: 'authority-revoked' }
    records[16] = { ...records[16], terminalReason: 'effect-unknown' }

    for (const [index, value] of records.entries()) {
      const result = gitOperationIntentRecordSchema.safeParse(value)
      expect(result.success, result.success ? undefined : `${index}: ${result.error.message}`).toBe(true)
    }
  })

  it('rejects stale record identity, digest, and time evidence', () => {
    expectGitIssue(
      record({ id: 'intent-00000000-0000-4000-8000-000000000099' }),
      'Intent id disagrees with immutable payload',
    )
    expectGitIssue(
      record({ receiptId: 'receipt-00000000-0000-4000-8000-000000000099' }),
      'receipt id disagrees with Intent id',
    )
    expectGitIssue(record({ payloadDigest: 'f'.repeat(64) }), 'Intent payload digest is stale')
    expectGitIssue(record({ createdAt: 7 }), 'Intent update predates creation')
  })

  it('requires one exact pre-Host conflict form before a Host request exists', () => {
    expectGitIssue(record({ hostRequest: undefined }), 'pre-Host Git Intent conflict has invalid evidence')
    expectGitIssue(record({
      hostRequest: undefined,
      phase: 'conflict',
      terminalReason: 'source-conflict',
    }), 'pre-Host Git Intent conflict has invalid evidence')
    expectGitIssue(record({
      hostRequest: undefined,
      phase: 'conflict',
      terminalReason: 'expected-evidence',
      reservationRevision: 1,
    }), 'pre-Host Git Intent conflict has invalid evidence')
    expectGitIssue(record({
      hostRequest: undefined,
      phase: 'conflict',
    }), 'Git Intent terminal reason disagrees with phase')
  })

  it('cross-checks every immutable Host request source field', () => {
    const mismatches = [
      { intentId: 'intent-00000000-0000-4000-8000-000000000099' },
      { intentRevision: 1 },
      { payloadDigest: 'f'.repeat(64) },
    ]
    for (const mismatch of mismatches) {
      expectGitIssue(record({
        hostRequest: { ...hostRequest, source: { ...source, ...mismatch } },
      }), 'Host request source disagrees with its Intent')
    }
  })

  it('cross-checks every browser-confirmed Host request evidence field', () => {
    const expectedMismatches = [
      {
        binding: {
          ...hostRequest.expected.binding,
          id: 'binding-00000000-0000-4000-8000-000000000099',
        },
      },
      { binding: { ...hostRequest.expected.binding, revision: 1 } },
      { status: { ...hostRequest.expected.status, digest: 'f'.repeat(64) } },
      { head: { ...hostRequest.expected.head, objectId: 'f'.repeat(40) } },
      { index: { ...hostRequest.expected.index, treeId: 'f'.repeat(40) } },
      { worktree: { ...hostRequest.expected.worktree, digest: 'f'.repeat(64) } },
    ]
    for (const mismatch of expectedMismatches) {
      expectGitIssue(record({
        hostRequest: { ...hostRequest, expected: { ...hostRequest.expected, ...mismatch } },
      }), 'Host request evidence disagrees with its Intent')
    }
  })

  it('cross-checks operation kind, selection, message, and actor Host', () => {
    expectGitIssue(record({
      hostRequest: { ...hostRequest, type: 'unstage-files' },
    }), 'Host request kind disagrees with its Intent')
    expectGitIssue(record({
      hostRequest: { ...hostRequest, changes: [hostRequest.changes[1], hostRequest.changes[0]] },
    }), 'Host request selection disagrees with its Intent')

    const commitIntent = SAKI_GIT_REQUEST_FIXTURES.commit
    const commitPayload = { intent: commitIntent, actor } as const
    const commitDigest = canonicalDigest('saki/git-operation-intent/v1', commitPayload)
    const commitSource = {
      ...source,
      intentId: commitIntent.intentId,
      payloadDigest: commitDigest,
    }
    const commitRequest = {
      type: 'commit',
      source: commitSource,
      expected: hostRequest.expected,
      message: commitIntent.message,
    } as const
    const commitRecord = {
      ...record(),
      id: commitIntent.intentId,
      receiptId: String(commitIntent.intentId).replace(/^intent-/u, 'receipt-'),
      payload: commitPayload,
      payloadDigest: commitDigest,
      hostRequest: commitRequest,
    }
    expectGitIssue({
      ...commitRecord,
      hostRequest: { ...commitRequest, message: 'different message' },
    }, 'Host request message disagrees with its Intent')
    expectGitIssue({
      ...commitRecord,
      hostRequest: { ...hostRequest, source: commitSource },
    }, 'Host request kind disagrees with its Intent')
    expectGitIssue(record({
      payload: { ...payload, actor: { ...actor, hostId: 'host-00000000-0000-4000-8000-000000000099' } },
      payloadDigest: canonicalDigest('saki/git-operation-intent/v1', {
        ...payload,
        actor: { ...actor, hostId: 'host-00000000-0000-4000-8000-000000000099' },
      }),
    }), 'Git operation actor belongs to another Host')
  })

  it('rejects missing, premature, and advanced phase evidence', () => {
    for (const laterEvidence of [
      { reservationRevision: 1 },
      { preparation },
      { admissionRevision: 2 },
      { operationSnapshot: preparedSnapshot },
    ]) {
      expectGitIssue(record(laterEvidence), 'prepared Git Intent retains later-phase evidence')
    }

    for (const invalid of [
      record({ phase: 'admission-reserved' }),
      record({ phase: 'admission-reserved', reservationRevision: 1, preparation }),
      record({ phase: 'admission-reserved', reservationRevision: 1, admissionRevision: 2 }),
      record({ phase: 'admission-reserved', reservationRevision: 1, operationSnapshot: preparedSnapshot }),
    ]) {
      expectGitIssue(invalid, 'reserved Git Intent has invalid phase evidence')
    }

    for (const invalid of [
      record({ phase: 'host-prepared', preparation, operationSnapshot: preparedSnapshot }),
      record({ phase: 'host-prepared', reservationRevision: 1, operationSnapshot: preparedSnapshot }),
      record({ phase: 'host-prepared', reservationRevision: 1, preparation, admissionRevision: 2,
        operationSnapshot: preparedSnapshot }),
      record({ phase: 'host-prepared', reservationRevision: 1, preparation }),
    ]) {
      expectGitIssue(invalid, 'Host-prepared Git Intent has invalid phase evidence')
    }
    expectGitIssue(
      hostEvidence('host-prepared', acceptedSnapshot, null),
      'Host-prepared Git Intent has advanced Host evidence',
    )

    for (const phase of ['accepted', 'succeeded'] as const) {
      for (const invalid of [
        record({ phase, preparation, admissionRevision: 2, operationSnapshot: acceptedSnapshot }),
        record({ phase, reservationRevision: 1, admissionRevision: 2, operationSnapshot: acceptedSnapshot }),
        record({ phase, reservationRevision: 1, preparation, operationSnapshot: acceptedSnapshot }),
        record({ phase, reservationRevision: 1, preparation, admissionRevision: 2 }),
      ]) {
        expectGitIssue(invalid, 'accepted Git Intent has incomplete operation evidence')
      }
    }
    expectGitIssue(
      hostEvidence('accepted', succeededSnapshot),
      'accepted Git Intent retains terminal Host evidence',
    )
  })

  it('accepts only no-effect conflict evidence and conflict reasons', () => {
    expectGitIssue({
      ...hostEvidence('conflict', acceptedSnapshot),
      terminalReason: 'source-conflict',
    }, 'conflicted Git Intent has possible-effect evidence')
    expectGitIssue({
      ...hostEvidence('conflict', preparedSnapshot, null),
      reservationRevision: undefined,
      terminalReason: 'protocol',
    }, 'conflicted Git Intent has possible-effect evidence')
    expectGitIssue(record({
      phase: 'conflict',
      terminalReason: 'unsupported-state',
    }), 'conflicted Git Intent has an invalid reason')
    for (const terminalReason of ['expected-evidence', 'invalid-selection'] as const) {
      expectGitIssue(record({ phase: 'conflict', terminalReason }),
        'pre-Host Git Intent conflict retains a Host request')
    }
  })

  it('rejects partial no-effect, canceled, and reconciliation evidence', () => {
    expectGitIssue(record({
      phase: 'failed',
      preparation,
      operationSnapshot: failedBeforeAdmissionSnapshot,
      terminalReason: 'invalid-selection',
    }), 'no-effect Git Intent has partial Host evidence')
    expectGitIssue(record({
      phase: 'canceled',
      admissionRevision: 2,
      terminalReason: 'source-canceled',
    }), 'no-effect Git Intent has partial Host evidence')
    expectGitIssue(record({
      phase: 'canceled',
      terminalReason: 'protocol',
    }), 'canceled Git Intent has an invalid reason')

    for (const invalid of [
      record({ phase: 'reconciliation-required', terminalReason: 'effect-unknown' }),
      record({ phase: 'reconciliation-required', reservationRevision: 1, preparation,
        admissionRevision: 2, operationSnapshot: acceptedSnapshot, terminalReason: 'effect-unknown' }),
    ]) {
      expectGitIssue(invalid, 'reconciliation Git Intent has incomplete unknown-effect evidence')
    }
  })

  it('cross-checks retained preparation and Host snapshot identity', () => {
    const preparationMismatches = [
      { operation: { ...operation, id: 'host-operation-00000000-0000-4000-8000-000000000099' } },
      { operation: { ...operation, hostId: 'host-00000000-0000-4000-8000-000000000099' } },
      { operation: { ...operation, type: 'unstage-files' } },
      { requestFingerprint: { ...preparation.requestFingerprint, digest: 'f'.repeat(64) } },
    ]
    for (const mismatch of preparationMismatches) {
      expectGitIssue({
        ...hostEvidence('host-prepared', preparedSnapshot, null),
        preparation: { ...preparation, ...mismatch },
      }, 'Git Intent preparation disagrees with Host snapshot')
    }

    const snapshotMismatches = [
      { source: { ...source, intentId: 'intent-00000000-0000-4000-8000-000000000099' } },
      { source: { ...source, intentRevision: 1 } },
      { source: { ...source, payloadDigest: 'f'.repeat(64) } },
      { bindingId: 'binding-00000000-0000-4000-8000-000000000099' },
      { bindingRevision: 1 },
    ]
    for (const mismatch of snapshotMismatches) {
      expectGitIssue({
        ...hostEvidence('host-prepared', preparedSnapshot, null),
        operationSnapshot: { ...preparedSnapshot, ...mismatch },
      }, 'Host snapshot disagrees with its Git Intent')
    }
    expectGitIssue(
      hostEvidence('accepted', { ...acceptedSnapshot, admission: { ...acceptedSnapshot.admission, revision: 3 } }),
      'Git Intent admission revision disagrees with Host evidence',
    )
  })

  it('cross-checks terminal phase, Host state, and terminal reason', () => {
    expectGitIssue(record({ terminalReason: 'protocol' }), 'Git Intent terminal reason disagrees with phase')
    expectGitIssue({
      ...hostEvidence('succeeded', acceptedSnapshot),
    }, 'succeeded Git Intent lacks a succeeded Host snapshot')
    expectGitIssue({
      ...hostEvidence('failed', acceptedSnapshot),
      terminalReason: 'unsupported-state',
    }, 'failed Git Intent lacks a failed Host snapshot')
    expectGitIssue({
      ...hostEvidence('failed', failedSnapshot),
      terminalReason: 'binding-stale',
    }, 'failed Git Intent reason disagrees with Host evidence')
    expectGitIssue({
      ...hostEvidence('canceled', failedSnapshot),
      terminalReason: 'authority-revoked',
    }, 'canceled Git Intent lacks a canceled Host snapshot')
    expectGitIssue({
      ...hostEvidence('canceled', canceledSnapshot),
      terminalReason: 'source-canceled',
    }, 'canceled Git Intent reason disagrees with Host evidence')
    expectGitIssue({
      ...hostEvidence('reconciliation-required', reconciliationSnapshot),
      terminalReason: 'evidence-conflict',
    }, 'reconciliation reason disagrees with Host evidence')
    expectGitIssue({
      ...hostEvidence('failed', failedBeforeAdmissionSnapshot, 2),
      terminalReason: 'invalid-selection',
    }, 'no-effect Git Intent retains an unproven admission revision')
  })

  it('validates write-admission time and action correlations', () => {
    const available = {
      id: project.binding.id,
      schemaVersion: 1,
      revision: 0,
      state: 'available',
      updatedAt: 1,
    } as const
    const reserved = {
      id: project.binding.id,
      schemaVersion: 1,
      revision: 1,
      state: 'manual-host-operation',
      bindingRevision: 0,
      source,
      action: 'project-changes:stage',
      phase: 'reserved',
      reservedAt: 2,
      updatedAt: 2,
    } as const
    const accepted = {
      ...reserved,
      revision: 2,
      phase: 'accepted',
      preparation,
      acceptedAt: 3,
      updatedAt: 4,
    } as const
    expect(bindingWriteAdmissionRecordSchema.safeParse(available).success).toBe(true)
    expect(bindingWriteAdmissionRecordSchema.safeParse(reserved).success).toBe(true)
    expect(bindingWriteAdmissionRecordSchema.safeParse(accepted).success).toBe(true)

    expectAdmissionIssue({ ...reserved, updatedAt: 1 }, 'write admission timestamps are not monotonic')
    expectAdmissionIssue({ ...accepted, acceptedAt: 1 }, 'write admission timestamps are not monotonic')
    expectAdmissionIssue({ ...accepted, acceptedAt: 5 }, 'write admission timestamps are not monotonic')
    expectAdmissionIssue({ ...accepted, action: 'project-changes:unstage' },
      'write admission action disagrees with Host preparation')

    const commitPreparation = {
      ...preparation,
      operation: { ...operation, type: 'commit' },
    } as const
    const unstagePreparation = {
      ...preparation,
      operation: { ...operation, type: 'unstage-files' },
    } as const
    expect(bindingWriteAdmissionRecordSchema.safeParse({
      ...accepted,
      action: 'project-commit:create',
      preparation: commitPreparation,
    }).success).toBe(true)
    expect(bindingWriteAdmissionRecordSchema.safeParse({
      ...accepted,
      action: 'project-changes:unstage',
      preparation: unstagePreparation,
    }).success).toBe(true)
    expectAdmissionIssue({ ...accepted, action: 'project-commit:create' },
      'write admission action disagrees with Host preparation')

    const pushReserved = { ...reserved, action: 'project-branch:push' }
    const pushAccepted = {
      ...accepted, action: 'project-branch:push',
      preparation: { ...preparation, operation: { ...operation, type: 'push-branch' } },
    }
    expect(bindingWriteAdmissionRecordSchema.safeParse(pushReserved).success).toBe(true)
    expect(bindingWriteAdmissionRecordSchema.safeParse(pushAccepted).success).toBe(true)
    for (const invalid of [
      { ...pushReserved, updatedAt: 1 },
      { ...pushAccepted, acceptedAt: 1 },
      { ...pushAccepted, acceptedAt: 5 },
    ]) expectAdmissionIssue(invalid, 'Push write admission timestamps are not monotonic')
    expectAdmissionIssue({ ...pushAccepted, preparation }, 'Push write admission disagrees with Host preparation')
  })

  it('rejects non-monotonic Agent admission timestamps in the frozen v7/v8 schema', () => {
    const reserved = {
      id: project.binding.id, schemaVersion: 1, revision: 1, state: 'agent-run', phase: 'reserved',
      bindingRevision: 0, originIntentId: intent.intentId,
      agentRunId: 'agent-run-00000000-0000-4000-8000-000000000001',
      payloadDigest: 'a'.repeat(64), reservedAt: 2, updatedAt: 4,
    }
    const accepted = { ...reserved, phase: 'accepted', acceptedAt: 3 }
    expect(bindingWriteAdmissionV2RecordSchema.safeParse(reserved).success).toBe(true)
    expect(bindingWriteAdmissionV2RecordSchema.safeParse(accepted).success).toBe(true)
    for (const invalid of [
      { ...reserved, updatedAt: 1 }, { ...accepted, acceptedAt: 1 }, { ...accepted, acceptedAt: 5 },
    ]) {
      const parsed = bindingWriteAdmissionV2RecordSchema.safeParse(invalid)
      expect(parsed.success).toBe(false)
      if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        message: 'Agent Run admission timestamps are not monotonic',
      }))
    }
  })
})
