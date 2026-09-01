import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'
import {
  agentRunRecordSchema,
  bindingWriteAdmissionRecordSchema,
  executionDispatchRecordSchema,
  sakiControlPlaneDomainSpec,
  type AgentRunRecord,
  type BindingWriteAdmissionRecord,
  type ExecutionDispatchRecord,
} from '@breakfastdapaidang/saki-control-plane'
import { SAKI_PROJECT_PROJECTION_FIXTURES } from '@breakfastdapaidang/saki-control-plane/src/fixtures.ts'
import {
  canonicalDigest,
  computeStartAgentRunPayloadDigest,
  hostOperationPreparationSchema,
  hostOperationSnapshotSchema,
  startAgentRunInputMessageSchema,
  startAgentRunHostOperationRequestSchema,
  type HostOperationPreparation,
  type HostOperationSnapshot,
  type StartAgentRunHostOperationRequest,
  type StartAgentRunHostOperationResult,
} from '@breakfastdapaidang/saki-execution'
import {
  sakiHostExecutionDomainSpec,
  type LocalHostOperationRecord,
} from '@breakfastdapaidang/saki-execution-local'
import * as stateValidation from '../src/state-validation.ts'

const INTENT_ID = 'intent-11111111-1111-4111-8111-111111111111'
const ASSIGNMENT_ID = 'assignment-22222222-2222-4222-8222-222222222222'
const WORK_SESSION_ID = 'work-session-33333333-3333-4333-8333-333333333333'
const AGENT_RUN_ID = 'agent-run-44444444-4444-4444-8444-444444444444'
const DISPATCH_ID = 'dispatch-55555555-5555-4555-8555-555555555555'
const OPERATION_ID = 'host-operation-55555555-5555-4555-8555-555555555555'
const ALT_OPERATION_ID = 'host-operation-66666666-6666-4666-8666-666666666666'
const CLAIM_ID = 'dispatch-claim-77777777-7777-4777-8777-777777777777'
const PROJECT_ID = 'project-88888888-8888-4888-8888-888888888888'
const WORK_ITEM_ID = `work-item-${'9'.repeat(64)}`
const BINDING_ID = 'binding-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOST_ID = 'host-00000000-0000-4000-8000-000000000002'
const SESSION_ID = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MESSAGE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PROFILE = {
  id: 'agent-profile-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  version: 1,
  agentPresetId: 'development',
  modelRoute: { provider: 'fixture', model: 'fixture-model' },
} as const
const TRUSTED_INSPECTION = {
  canonicalWorktreePath: '/fixture/repository',
  canonicalGitDirectory: '/fixture/repository/.git',
  canonicalCommonGitDirectory: '/fixture/repository/.git',
  gitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
  commonGitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
  comparison: { fileMode: true, symlinks: true, autocrlf: false },
}

interface Fixture {
  readonly request: StartAgentRunHostOperationRequest
  readonly preparation: HostOperationPreparation
  readonly preparedSnapshot: HostOperationSnapshot
  readonly hostOperation: LocalHostOperationRecord
  readonly dispatch: ExecutionDispatchRecord
  readonly run: AgentRunRecord
  readonly reservedAdmission: BindingWriteAdmissionRecord
}

interface LinkedState {
  readonly runs?: readonly AgentRunRecord[]
  readonly dispatches?: readonly ExecutionDispatchRecord[]
  readonly admissions?: readonly BindingWriteAdmissionRecord[]
  readonly hostOperations?: readonly LocalHostOperationRecord[]
}

function fixture(): Fixture {
  const input = startAgentRunInputMessageSchema.parse({
    id: MESSAGE_ID,
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Implement the frozen Work Item.' }],
    source: {
      kind: 'saki-agent-run' as const,
      dispatchId: DISPATCH_ID,
      agentRunId: AGENT_RUN_ID,
      workSessionId: WORK_SESSION_ID,
    },
  })
  const request = startAgentRunHostOperationRequestSchema.parse({
    type: 'start-agent-run',
    source: {
      kind: 'execution-dispatch',
      dispatchId: DISPATCH_ID,
      payloadDigest: computeStartAgentRunPayloadDigest(input),
    },
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
      status: { version: 1, digest: '2'.repeat(64) },
      head: { kind: 'commit', objectId: '3'.repeat(40), symbolicRef: 'refs/heads/main' },
      index: { kind: 'tree', treeId: '4'.repeat(40) },
      worktree: { version: 1, digest: '5'.repeat(64) },
      preEffectBaseline: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.baseline,
    },
    run: {
      agentRunId: AGENT_RUN_ID,
      workSessionId: WORK_SESSION_ID,
      sessionId: SESSION_ID,
      profile: PROFILE,
      input,
    },
  })
  const prepared = preparedOperation(request)
  const dispatch = executionDispatchRecordSchema.parse({
    id: DISPATCH_ID,
    schemaVersion: 1,
    revision: 1,
    intentId: INTENT_ID,
    agentRunId: AGENT_RUN_ID,
    workSessionId: WORK_SESSION_ID,
    hostId: HOST_ID,
    bindingId: BINDING_ID,
    payloadDigest: request.source.payloadDigest,
    hostRequest: request,
    state: 'claimed',
    latestFencingToken: 1,
    claim: {
      id: CLAIM_ID,
      executorHostId: HOST_ID,
      fencingToken: 1,
      issuedAt: 2,
      expiresAt: 100,
    },
    createdAt: 1,
    updatedAt: 2,
  })
  const run = agentRunRecordSchema.parse({
    id: AGENT_RUN_ID,
    schemaVersion: 1,
    revision: 0,
    intentId: INTENT_ID,
    assignmentId: ASSIGNMENT_ID,
    workSessionId: WORK_SESSION_ID,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    bindingId: BINDING_ID,
    profile: PROFILE,
    sessionId: SESSION_ID,
    inputPlan: { messageId: MESSAGE_ID, payloadDigest: request.source.payloadDigest },
    dispatchIds: [DISPATCH_ID],
    state: 'allocated',
    createdAt: 1,
    updatedAt: 1,
  })
  const reservedAdmission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 1,
    state: 'agent-run',
    phase: 'reserved',
    bindingRevision: 0,
    originIntentId: INTENT_ID,
    agentRunId: AGENT_RUN_ID,
    payloadDigest: request.source.payloadDigest,
    reservedAt: 2,
    updatedAt: 2,
  })
  return {
    request,
    preparation: prepared.preparation,
    preparedSnapshot: prepared.snapshot,
    hostOperation: prepared.record,
    dispatch,
    run,
    reservedAdmission,
  }
}

function preparedOperation(
  request: StartAgentRunHostOperationRequest,
  operationId = OPERATION_ID,
  updatedAt = 2,
): {
  readonly preparation: HostOperationPreparation
  readonly snapshot: HostOperationSnapshot
  readonly record: LocalHostOperationRecord
} {
  const requestFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/host-operation-request/v1', request),
  }
  const operation = { id: operationId, hostId: HOST_ID, type: 'start-agent-run' as const }
  const preparation = hostOperationPreparationSchema.parse({
    operation,
    preparationRevision: 0,
    requestFingerprint,
  })
  const snapshot = hostOperationSnapshotSchema.parse({
    operation,
    revision: 0,
    source: request.source,
    requestFingerprint,
    bindingId: BINDING_ID,
    bindingRevision: 0,
    preparedAt: 2,
    updatedAt,
    state: 'prepared',
    admission: { kind: 'not-accepted' },
  })
  const record = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    schemaVersion: 2,
    request,
    preparationRevision: 0,
    snapshot,
  })
  return { preparation, snapshot, record }
}

function retainedPreparation(current: Fixture): ExecutionDispatchRecord {
  return executionDispatchRecordSchema.parse({
    ...current.dispatch,
    revision: 2,
    preparation: current.preparation,
    operationSnapshot: current.preparedSnapshot,
    updatedAt: 3,
  })
}

function runningState(current: Fixture): Required<LinkedState> {
  const result: StartAgentRunHostOperationResult = {
    type: 'start-agent-run',
    agentRunId: current.request.run.agentRunId,
    workSessionId: current.request.run.workSessionId,
    sessionId: current.request.run.sessionId,
    inputMessageId: current.request.run.input.id,
  }
  const snapshot = hostOperationSnapshotSchema.parse({
    ...current.preparedSnapshot,
    revision: 4,
    updatedAt: 6,
    state: 'succeeded',
    admission: { kind: 'accepted', revision: 2, acceptedAt: 3 },
    completedAt: 6,
    result,
  })
  return {
    runs: [agentRunRecordSchema.parse({
      ...current.run,
      revision: 2,
      state: 'running',
      hostResult: result,
      updatedAt: 6,
    })],
    dispatches: [executionDispatchRecordSchema.parse({
      ...current.dispatch,
      revision: 4,
      state: 'accepted',
      claim: undefined,
      acceptedFencingToken: 1,
      preparation: current.preparation,
      operationSnapshot: snapshot,
      updatedAt: 6,
    })],
    admissions: [bindingWriteAdmissionRecordSchema.parse({
      ...current.reservedAdmission,
      revision: 2,
      phase: 'accepted',
      acceptedAt: 3,
      updatedAt: 3,
    })],
    hostOperations: [sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      ...current.hostOperation,
      snapshot,
      effectPlan: { kind: 'agent-run', publication: 'applied-recorded', result },
    })],
  }
}

function acceptedHostState(current: Fixture): Required<LinkedState> {
  const snapshot = hostOperationSnapshotSchema.parse({
    ...current.preparedSnapshot,
    revision: 1,
    updatedAt: 3,
    state: 'accepted',
    admission: { kind: 'accepted', revision: 2, acceptedAt: 3 },
  })
  return {
    runs: [agentRunRecordSchema.parse({
      ...current.run,
      revision: 1,
      state: 'starting',
      updatedAt: 3,
    })],
    dispatches: [executionDispatchRecordSchema.parse({
      ...current.dispatch,
      revision: 3,
      state: 'accepted',
      claim: undefined,
      acceptedFencingToken: 1,
      preparation: current.preparation,
      operationSnapshot: snapshot,
      updatedAt: 3,
    })],
    admissions: [current.reservedAdmission],
    hostOperations: [sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      ...current.hostOperation,
      snapshot,
    })],
  }
}

function domains(state: LinkedState): readonly [
  Domain<typeof sakiControlPlaneDomainSpec>,
  Domain<typeof sakiHostExecutionDomainSpec>,
] {
  const controlTables = new Map<string, ReturnType<typeof readonlyTable>>([
    ['agent_runs', readonlyTable((state.runs ?? []).map(record => [record.id, record]))],
    ['execution_dispatches', readonlyTable((state.dispatches ?? []).map(record => [record.id, record]))],
    ['binding_write_admissions', readonlyTable((state.admissions ?? []).map(record => [record.id, record]))],
  ])
  const controlPlane = {
    name: sakiControlPlaneDomainSpec.name,
    table: (name: string) => controlTables.get(name),
    close: () => Promise.resolve(),
  } as unknown as Domain<typeof sakiControlPlaneDomainSpec>
  const hostExecution = {
    name: sakiHostExecutionDomainSpec.name,
    table: () => readonlyTable((state.hostOperations ?? [])
      .map(record => [record.snapshot.operation.id, record])),
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

type AgentOperationLinkValidator = (
  controlPlane: Domain<typeof sakiControlPlaneDomainSpec>,
  hostExecution: Domain<typeof sakiHostExecutionDomainSpec>,
) => void

function validator(): AgentOperationLinkValidator {
  const candidate: unknown = Reflect.get(stateValidation, 'validateAgentOperationLinks')
  if (!isValidator(candidate)) throw new Error('validateAgentOperationLinks is not implemented')
  return candidate
}

function isValidator(candidate: unknown): candidate is AgentOperationLinkValidator {
  return typeof candidate === 'function'
}

describe('current StartAgentRun cross-domain validation', () => {
  it('accepts the prepared Host record before the claimed Dispatch can retain it', () => {
    const validateAgentOperationLinks = validator()
    const current = fixture()
    const [controlPlane, hostExecution] = domains({
      runs: [current.run],
      dispatches: [current.dispatch],
      admissions: [current.reservedAdmission],
      hostOperations: [current.hostOperation],
    })

    expect(() => { validateAgentOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts one exact accepted Dispatch, running Agent Run, and succeeded Host Operation', () => {
    const validateAgentOperationLinks = validator()
    const [controlPlane, hostExecution] = domains(runningState(fixture()))

    expect(() => { validateAgentOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('rejects an orphan StartAgentRun Host Operation', () => {
    const validateAgentOperationLinks = validator()
    const current = fixture()
    const [controlPlane, hostExecution] = domains({ hostOperations: [current.hostOperation] })

    expect(() => { validateAgentOperationLinks(controlPlane, hostExecution) }).toThrow()
  })

  it('rejects Dispatch preparation after its Host Operation disappears', () => {
    const validateAgentOperationLinks = validator()
    const current = fixture()
    const [controlPlane, hostExecution] = domains({
      runs: [current.run],
      dispatches: [retainedPreparation(current)],
      admissions: [current.reservedAdmission],
    })

    expect(() => { validateAgentOperationLinks(controlPlane, hostExecution) }).toThrow()
  })

  it('rejects a Host request that differs from its Dispatch request', () => {
    const validateAgentOperationLinks = validator()
    const current = fixture()
    const mismatchedRequest = startAgentRunHostOperationRequestSchema.parse({
      ...current.request,
      expected: {
        ...current.request.expected,
        status: { version: 1, digest: 'f'.repeat(64) },
      },
    })
    const mismatchedHost = preparedOperation(mismatchedRequest).record
    const [controlPlane, hostExecution] = domains({
      runs: [current.run],
      dispatches: [current.dispatch],
      admissions: [current.reservedAdmission],
      hostOperations: [mismatchedHost],
    })

    expect(() => { validateAgentOperationLinks(controlPlane, hostExecution) }).toThrow()
  })

  it('accepts a mismatched prepared Host request only after the Dispatch enters reconciliation', () => {
    const validateAgentOperationLinks = validator()
    const current = fixture()
    const mismatchedRequest = startAgentRunHostOperationRequestSchema.parse({
      ...current.request,
      expected: {
        ...current.request.expected,
        status: { version: 1, digest: 'f'.repeat(64) },
      },
    })
    const mismatchedHost = preparedOperation(mismatchedRequest).record
    const [controlPlane, hostExecution] = domains({
      runs: [agentRunRecordSchema.parse({
        ...current.run,
        revision: 1,
        state: 'reconciliation-required',
        updatedAt: 3,
      })],
      dispatches: [executionDispatchRecordSchema.parse({
        ...current.dispatch,
        revision: 2,
        state: 'reconciliation-required',
        claim: undefined,
        terminalReason: 'protocol',
        updatedAt: 3,
      })],
      admissions: [current.reservedAdmission],
      hostOperations: [mismatchedHost],
    })

    expect(() => { validateAgentOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('rejects future and same-revision-different Dispatch snapshots', () => {
    const validateAgentOperationLinks = validator()
    const current = fixture()
    const future = executionDispatchRecordSchema.parse({
      ...retainedPreparation(current),
      operationSnapshot: { ...current.preparedSnapshot, revision: 1 },
    })
    const changedHost = preparedOperation(current.request, OPERATION_ID, 3).record
    const cases = [
      domains({
        runs: [current.run],
        dispatches: [future],
        admissions: [current.reservedAdmission],
        hostOperations: [current.hostOperation],
      }),
      domains({
        runs: [current.run],
        dispatches: [retainedPreparation(current)],
        admissions: [current.reservedAdmission],
        hostOperations: [changedHost],
      }),
    ] as const

    for (const [controlPlane, hostExecution] of cases) {
      expect(() => { validateAgentOperationLinks(controlPlane, hostExecution) }).toThrow()
    }
  })

  it('rejects multiple Host records sourced from one Dispatch', () => {
    const validateAgentOperationLinks = validator()
    const current = fixture()
    const duplicate = preparedOperation(current.request, ALT_OPERATION_ID).record
    const [controlPlane, hostExecution] = domains({
      runs: [current.run],
      dispatches: [current.dispatch],
      admissions: [current.reservedAdmission],
      hostOperations: [current.hostOperation, duplicate],
    })

    expect(() => { validateAgentOperationLinks(controlPlane, hostExecution) }).toThrow()
  })

  it('rejects a nonterminal accepted Host operation without its accepted Agent Run admission', () => {
    const validateAgentOperationLinks = validator()
    const [controlPlane, hostExecution] = domains(acceptedHostState(fixture()))

    expect(() => { validateAgentOperationLinks(controlPlane, hostExecution) }).toThrow()
  })
})
