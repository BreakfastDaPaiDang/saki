import { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubReadRequest } from '@breakfastdapaidang/saki-github'
import {
  canonicalDigest,
  computeStartAgentRunPayloadDigest,
  HostOperationAcceptance,
  MAX_START_AGENT_RUN_INPUT_UTF8_BYTES,
  SakiHostExecution,
  startAgentRunHostOperationRequestSchema,
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
  StartAgentRunHostOperationRequest,
} from '@breakfastdapaidang/saki-execution'
import { AgentOperations } from '../src/agent-operations.ts'
import { SAKI_BOARD_PROJECTION_FIXTURES, SAKI_GIT_CHANGES_PROJECTION_FIXTURES, SAKI_PROJECT_PROJECTION_FIXTURES, SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES } from '../src/fixtures.ts'
import { activeHostProjectBinding } from '../src/projects.ts'
import {
  agentOperationIntentRecordSchema,
  agentRunRecordSchema,
  bindingWriteAdmissionRecordSchema,
  developmentProjectRegistryRecordSchema,
  executionDispatchRecordSchema,
  giveWorkItemToAgentIntentSchema,
  resourceBindingRecordSchema,
  workAssignmentRecordSchema,
  workSessionRecordSchema,
} from '../src/spec.ts'
import type {
  AgentOperationIntentRecord,
  AgentRunRecord,
  BindingWriteAdmissionRecord,
  ControlIntentActor,
  DevelopmentProjectRegistryRecord,
  ExecutionDispatchRecord,
  WorkAssignmentRecord,
  WorkSessionRecord,
} from '../src/spec.ts'
import type {
  GiveWorkItemToAgentIntent,
  MoveWorkItemIntent,
  SakiAgentRunId,
  SakiControlIntentId,
  SakiExecutionDispatchId,
  SakiGrantId,
  SakiInstallationId,
  SakiPrincipalId,
  SakiResourceBindingId,
  SakiStorageGenerationId,
  SakiWorkAssignmentId,
  SakiWorkItemIntentReceipt,
  SakiWorkSessionId,
} from '../src/types.ts'

describe('manual Give-to-Agent operations', () => {
  it('accepts only the minimal browser Intent and rejects execution authority', () => {
    const intent = {
      type: 'give-work-item-to-agent',
      intentId: 'intent-11111111-1111-4111-8111-111111111111',
      projectId: 'project-22222222-2222-4222-8222-222222222222',
      workItemId: `work-item-${'3'.repeat(64)}`,
      expectedProjectRevision: 4,
      expectedRemoteFingerprint: `remote-fingerprint-${'5'.repeat(64)}`,
    } as const

    expect(giveWorkItemToAgentIntentSchema.parse(intent)).toEqual(intent)
    for (const injected of [
      { actor: 'browser' },
      { grantRevision: 1 },
      { hostId: 'host-66666666-6666-4666-8666-666666666666' },
      { assignmentId: 'assignment-77777777-7777-4777-8777-777777777777' },
      { workSessionId: 'work-session-88888888-8888-4888-8888-888888888888' },
      { agentRunId: 'agent-run-99999999-9999-4999-8999-999999999999' },
      { dispatchId: 'dispatch-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { agentProfileId: 'agent-profile-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { modelRoute: { provider: 'browser', model: 'browser' } },
    ]) {
      expect(giveWorkItemToAgentIntentSchema.safeParse({ ...intent, ...injected }).success).toBe(false)
    }
  })

  it('uses the sole Binding admission row for a long-lived Agent Run holder', () => {
    const admission = {
      id: 'binding-11111111-1111-4111-8111-111111111111',
      schemaVersion: 1,
      revision: 7,
      state: 'agent-run',
      phase: 'accepted',
      bindingRevision: 3,
      originIntentId: 'intent-22222222-2222-4222-8222-222222222222',
      agentRunId: 'agent-run-33333333-3333-4333-8333-333333333333',
      payloadDigest: '4'.repeat(64),
      reservedAt: 100,
      acceptedAt: 110,
      updatedAt: 110,
    } as const

    expect(bindingWriteAdmissionRecordSchema.parse(admission)).toEqual(admission)
    expect(bindingWriteAdmissionRecordSchema.safeParse({
      ...admission,
      dispatchId: 'dispatch-55555555-5555-4555-8555-555555555555',
    }).success).toBe(false)
  })

  it('validates inverse write-admission ownership across the Agent lifecycle', async () => {
    const replaceWithAvailable = (test: Harness): void => {
      const current = only(test.admissions)
      test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
        id: BINDING_ID,
        schemaVersion: 1,
        revision: current.revision + 1,
        state: 'available',
        updatedAt: current.updatedAt + 1,
      }))
    }

    const reserved = harness()
    reserved.execution.prepareMode = 'unavailable'
    await reserved.operations.submit(
      intent('intent-18181818-1818-4818-8818-181818181818' as SakiControlIntentId),
      actor(),
      AbortSignal.timeout(5_000),
    )
    const reservedIntent = only(reserved.intents)
    reserved.intents.records.set(reservedIntent.id, agentOperationIntentRecordSchema.parse({
      ...reservedIntent,
      phase: 'admission-reserved',
    }))
    const reservedDispatch = only(reserved.dispatches)
    reserved.dispatches.records.set(reservedDispatch.id, executionDispatchRecordSchema.parse({
      ...reservedDispatch,
      state: 'pending',
      claim: undefined,
    }))
    expect(() => reserved.operations.validateDurableState(new Set(), reserved.registry)).not.toThrow()
    replaceWithAvailable(reserved)
    expect(() => reserved.operations.validateDurableState(new Set(), reserved.registry))
      .toThrow('exact reserved write admission')

    const dispatching = harness()
    dispatching.execution.prepareMode = 'unavailable'
    await dispatching.operations.submit(
      intent('intent-19191919-1919-4919-8919-191919191919' as SakiControlIntentId),
      actor(),
      AbortSignal.timeout(5_000),
    )
    replaceWithAvailable(dispatching)
    expect(() => dispatching.operations.validateDurableState(new Set(), dispatching.registry))
      .toThrow('incompatible write admission')

    const accepted = harness()
    accepted.execution.startMode = 'unavailable'
    await accepted.operations.submit(
      intent('intent-20202020-2020-4020-8020-202020202020' as SakiControlIntentId),
      actor(),
      AbortSignal.timeout(5_000),
    )
    const acceptedAdmission = only(accepted.admissions)
    if (acceptedAdmission.state !== 'agent-run') throw new Error('test admission is not owned by the Agent Run')
    accepted.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
      id: acceptedAdmission.id,
      schemaVersion: 1,
      revision: acceptedAdmission.revision,
      state: 'agent-run',
      phase: 'reserved',
      bindingRevision: acceptedAdmission.bindingRevision,
      originIntentId: acceptedAdmission.originIntentId,
      agentRunId: acceptedAdmission.agentRunId,
      payloadDigest: acceptedAdmission.payloadDigest,
      reservedAt: acceptedAdmission.reservedAt,
      updatedAt: acceptedAdmission.updatedAt,
    }))
    expect(() => accepted.operations.validateDurableState(new Set(), accepted.registry))
      .toThrow('incompatible write admission')

    const started = harness()
    await started.operations.submit(
      intent('intent-21212121-2121-4121-8121-212121212121' as SakiControlIntentId),
      actor(),
      AbortSignal.timeout(5_000),
    )
    replaceWithAvailable(started)
    expect(() => started.operations.validateDurableState(new Set(), started.registry))
      .toThrow('exact accepted write admission')

    const reconciling = harness()
    reconciling.execution.startMode = 'reconciliation'
    await reconciling.operations.submit(
      intent('intent-22222222-2222-4222-8222-222222222223' as SakiControlIntentId),
      actor(),
      AbortSignal.timeout(5_000),
    )
    replaceWithAvailable(reconciling)
    expect(() => reconciling.operations.validateDurableState(new Set(), reconciling.registry))
      .toThrow('exact accepted write admission')

    const canceled = harness()
    canceled.execution.startMode = 'unavailable'
    const canceledIntent = intent('intent-23232323-2323-4323-8323-232323232323' as SakiControlIntentId)
    await canceled.operations.submit(canceledIntent, actor(), AbortSignal.timeout(5_000))
    const retainedOwner = only(canceled.admissions)
    canceled.authorityCurrent = false
    await canceled.operations.submit(canceledIntent, actor(), AbortSignal.timeout(5_000))
    canceled.admissions.records.set(BINDING_ID, retainedOwner)
    expect(() => canceled.operations.validateDurableState(new Set(), canceled.registry))
      .toThrow('retains its write admission')
  })

  it('persists one exact Run and moves the Work Item only after Host success', async () => {
    const test = harness()
    const submitted = intent()

    const result = await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))

    expect(result).toMatchObject({ ok: true, receipt: { state: 'started' } })
    if (!result.ok) throw new Error('test Agent operation did not start')
    expect(test.execution.prepareCount).toBe(2)
    expect(test.execution.startCount).toBe(1)
    expect(test.moves).toHaveLength(1)
    expect(test.moves[0]).toMatchObject({
      type: 'move-work-item',
      workItemId: submitted.workItemId,
      expectedRemoteFingerprint: submitted.expectedRemoteFingerprint,
      targetStatus: 'in-progress',
    })
    expect(test.dispatches.size).toBe(1)
    expect(test.runs.size).toBe(1)
    const run = test.runs.get(result.receipt.agentRunId)
    expect(run).toMatchObject({
      id: result.receipt.agentRunId,
      workSessionId: result.receipt.workSessionId,
      state: 'running',
      dispatchIds: [result.receipt.dispatchId],
    })
    const request = test.execution.request
    expect(request?.run.input.id).toBe(run?.inputPlan.messageId)
    expect(request?.run.input.source).toEqual({
      kind: 'saki-agent-run',
      dispatchId: result.receipt.dispatchId,
      agentRunId: result.receipt.agentRunId,
      workSessionId: result.receipt.workSessionId,
    })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({
      state: 'agent-run',
      phase: 'accepted',
      originIntentId: submitted.intentId,
      agentRunId: result.receipt.agentRunId,
    })
    const validated = test.operations.validateDurableState(new Set(), test.registry)
    expect(validated.intents).toHaveLength(1)
    expect(validated.runningAgentRuns).toEqual([{
      operation: only(test.dispatches).preparation?.operation,
      request: only(test.dispatches).hostRequest,
    }])
    expect(() => test.operations.validateDurableState(new Set([submitted.intentId]), test.registry))
      .toThrow('retained by multiple Intent kinds')

    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))).toEqual(result)
    expect(test.execution.prepareCount).toBe(2)
    expect(test.execution.startCount).toBe(1)
    expect(test.moves).toHaveLength(1)
  })

  it('rejects an unresolved exact Model Route before accepting the Intent', async () => {
    const test = harness()
    const submitted = intent('intent-31313131-3131-4131-8131-313131313131' as SakiControlIntentId)
    test.modelRouteAvailable = false

    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'model-route-unavailable',
    })
    expect(test.resolvedModelRoutes).toEqual([{ provider: 'test-provider', model: 'test-model' }])
    expect(test.intents.size).toBe(0)
    expect(test.assignments.size).toBe(0)
    expect(test.sessions.size).toBe(0)
    expect(test.runs.size).toBe(0)
    expect(test.dispatches.size).toBe(0)
    expect(only(test.admissions)).toMatchObject({ state: 'available', revision: 0 })
    expect(test.execution.prepareCount).toBe(0)

    test.modelRouteAvailable = true
    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: true, receipt: { state: 'started' } })
    expect(test.resolvedModelRoutes).toEqual([
      { provider: 'test-provider', model: 'test-model' },
      { provider: 'test-provider', model: 'test-model' },
    ])
  })

  it('advances the fencing token after an expired claim without allocating a second Run', async () => {
    const test = harness()
    const submitted = intent('intent-99999999-9999-4999-8999-999999999999' as SakiControlIntentId)
    test.execution.prepareMode = 'unavailable'

    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } })
    const first = only(test.dispatches)
    expect(first).toMatchObject({ state: 'claimed', latestFencingToken: 1 })
    if (first.state !== 'claimed' || first.claim === undefined) throw new Error('test Dispatch is not claimed')
    test.dispatches.records.set(first.id, executionDispatchRecordSchema.parse({
      ...first,
      claim: { ...first.claim, issuedAt: 0, expiresAt: 1 },
    }))
    test.execution.prepareMode = 'success'

    const recovered = await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))

    expect(recovered).toMatchObject({ ok: true, receipt: { state: 'started' } })
    expect(only(test.dispatches)).toMatchObject({
      state: 'accepted',
      latestFencingToken: 2,
      acceptedFencingToken: 2,
    })
    expect(Object.hasOwn(only(test.dispatches), 'claim')).toBe(false)
    expect(test.runs.size).toBe(1)
    expect(test.execution.startCount).toBe(1)
  })

  it('renews the same executor claim with one CAS and no fencing-token change', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const test = harness()
      const submitted = intent('intent-33333333-3333-4333-8333-333333333333' as SakiControlIntentId)
      test.execution.prepareMode = 'unavailable'
      await test.operations.submit(submitted, actor(), new AbortController().signal)
      const first = only(test.dispatches)
      if (first.state !== 'claimed' || first.claim === undefined) throw new Error('test Dispatch is not claimed')
      expect(first.claim).toMatchObject({ fencingToken: 1, issuedAt: 1_000, expiresAt: 31_000 })

      vi.setSystemTime(2_000)
      await test.operations.submit(submitted, actor(), new AbortController().signal)

      const renewed = only(test.dispatches)
      expect(renewed).toMatchObject({
        state: 'claimed',
        revision: first.revision + 1,
        latestFencingToken: 1,
        claim: {
          id: first.claim.id,
          executorHostId: first.claim.executorHostId,
          fencingToken: 1,
          issuedAt: 1_000,
          expiresAt: 32_000,
        },
      })
      expect(test.execution.prepareCount).toBe(2)
      expect(test.execution.startCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['different owner', 'stale revision'] as const)(
    'rejects claim renewal from a %s without reaching Host preparation',
    async (conflict) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      try {
        const test = harness()
        const submitted = intent('intent-34343434-3434-4434-8434-343434343434' as SakiControlIntentId)
        test.execution.prepareMode = 'unavailable'
        await test.operations.submit(submitted, actor(), new AbortController().signal)
        const first = only(test.dispatches)
        if (first.state !== 'claimed' || first.claim === undefined) throw new Error('test Dispatch is not claimed')
        if (conflict === 'different owner') {
          test.dispatches.records.set(first.id, executionDispatchRecordSchema.parse({
            ...first,
            claim: {
              ...first.claim,
              executorHostId: 'host-35353535-3535-4535-8535-353535353535',
            },
          }))
        } else {
          test.dispatches.beforeNextUpdate = () => {
            const current = only(test.dispatches)
            test.dispatches.records.set(current.id, executionDispatchRecordSchema.parse({
              ...current,
              revision: current.revision + 1,
              updatedAt: current.updatedAt + 1,
            }))
          }
        }

        vi.setSystemTime(2_000)
        expect(await test.operations.submit(submitted, actor(), new AbortController().signal))
          .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } })
        expect(test.execution.prepareCount).toBe(1)
        expect(test.execution.startCount).toBe(0)
        expect(only(test.dispatches)).toMatchObject({
          state: 'claimed',
          latestFencingToken: 1,
          claim: { expiresAt: 31_000 },
        })
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('does not accept a claim that expires while Host preparation is in flight', async () => {
    const test = harness()
    const submitted = intent('intent-17171717-1717-4717-8717-171717171717' as SakiControlIntentId)
    test.execution.afterPrepare = () => {
      const claimed = only(test.dispatches)
      if (claimed.state !== 'claimed' || claimed.claim === undefined) throw new Error('test Dispatch was not claimed')
      test.dispatches.records.set(claimed.id, executionDispatchRecordSchema.parse({
        ...claimed,
        claim: { ...claimed.claim, issuedAt: 0, expiresAt: 1 },
      }))
    }

    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } })
    expect(only(test.dispatches)).toMatchObject({
      state: 'claimed',
      latestFencingToken: 1,
      preparation: { operation: { type: 'start-agent-run' } },
      operationSnapshot: { state: 'prepared' },
    })
    expect(only(test.admissions)).toMatchObject({ state: 'agent-run', phase: 'reserved' })
    expect(test.execution.startCount).toBe(0)

    const recovered = await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))

    expect(recovered).toMatchObject({ ok: true, receipt: { state: 'started' } })
    expect(only(test.dispatches)).toMatchObject({
      state: 'accepted',
      latestFencingToken: 2,
      acceptedFencingToken: 2,
    })
    expect(test.execution.startCount).toBe(1)
    expect(test.runs.size).toBe(1)
  })

  it('atomically rejects a claim that expires while admission acceptance is in flight', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const test = harness()
      const submitted = intent('intent-28282828-2828-4828-8828-282828282828' as SakiControlIntentId)
      test.execution.afterPrepare = () => {
        test.admissions.afterNextUpdate = () => { vi.setSystemTime(31_000) }
      }

      expect(await test.operations.submit(submitted, actor(), new AbortController().signal))
        .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } })
      expect(only(test.dispatches)).toMatchObject({
        state: 'claimed',
        latestFencingToken: 1,
        preparation: { operation: { type: 'start-agent-run' } },
        operationSnapshot: { state: 'prepared' },
      })
      expect(only(test.admissions)).toMatchObject({ state: 'agent-run', phase: 'accepted' })
      expect(test.execution.startCount).toBe(0)
      expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()

      vi.setSystemTime(31_001)
      expect(await test.operations.submit(submitted, actor(), new AbortController().signal))
        .toMatchObject({ ok: true, receipt: { state: 'started' } })
      expect(only(test.dispatches)).toMatchObject({
        state: 'accepted',
        latestFencingToken: 2,
        acceptedFencingToken: 2,
      })
      expect(test.execution.startCount).toBe(1)
      expect(test.execution.prepareCount).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['authority', 'Binding'] as const)(
    'rechecks current %s after Host preparation before accepting its Dispatch',
    async (changed) => {
      const test = harness()
      const submitted = intent('intent-36363636-3636-4636-8636-363636363636' as SakiControlIntentId)
      test.execution.afterPrepare = () => {
        if (changed === 'authority') test.authorityCurrent = false
        else test.bindingCurrent = false
      }

      expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
        .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } })
      expect(only(test.dispatches)).toMatchObject({
        state: 'claimed',
        preparation: { operation: { type: 'start-agent-run' } },
        operationSnapshot: { state: 'prepared' },
      })
      expect(only(test.admissions)).toMatchObject({ state: 'agent-run', phase: 'reserved' })
      expect(test.execution.startCount).toBe(0)

      test.authorityCurrent = true
      test.bindingCurrent = true
      expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
        .toMatchObject({ ok: true, receipt: { state: 'started' } })
      expect(test.execution.startCount).toBe(1)
    },
  )

  it('replays a lost final acceptance acknowledgement without a second Host start', async () => {
    const test = harness()
    const submitted = intent('intent-37373737-3737-4737-8737-373737373737' as SakiControlIntentId)
    test.execution.afterPrepare = () => {
      test.admissions.afterNextUpdate = () => {
        test.dispatches.afterNextUpdate = () => { throw new Error('simulated acceptance acknowledgement loss') }
      }
    }

    const started = await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))

    expect(started).toMatchObject({ ok: true, receipt: { state: 'started' } })
    expect(only(test.dispatches)).toMatchObject({ state: 'accepted', acceptedFencingToken: 1 })
    expect(test.execution.startCount).toBe(1)
    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))).toEqual(started)
    expect(test.execution.startCount).toBe(1)
  })

  it.each([
    ['persisted before claim', (test: Harness) => {
      test.dispatches.simulateCrashAfterPutWhen(dispatch => dispatch.state === 'pending')
    }],
    ['after claim', (test: Harness) => {
      test.dispatches.simulateCrashAfterUpdateWhen(dispatch => dispatch.state === 'claimed'
        && dispatch.preparation === undefined)
    }],
    ['after Host preparation', (test: Harness) => {
      test.execution.afterPrepare = () => {
        throw new SimulatedProcessCrash('Host preparation committed before the process stopped')
      }
    }],
    ['after acceptance', (test: Harness) => {
      test.dispatches.simulateCrashAfterUpdateWhen(dispatch => dispatch.state === 'accepted')
    }],
    ['after start', (test: Harness) => {
      test.execution.afterStart = () => {
        throw new SimulatedProcessCrash('Host start committed before the process stopped')
      }
    }],
  ] as const)('rebuilds the runtime and replays safely when it stops %s', async (_checkpoint, inject) => {
    const test = harness()
    const submitted = intent('intent-38383838-3838-4838-8838-383838383838' as SakiControlIntentId)
    inject(test)

    await expect(test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow(SimulatedProcessCrash)
    test.restart()
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()

    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: true, receipt: { state: 'started' } })
    expect(test.execution.startCount).toBe(1)
    expect(test.moves).toHaveLength(1)
    expect(test.runs.size).toBe(1)
    expect(only(test.runs)).toMatchObject({ state: 'running' })
    expect(only(test.dispatches)).toMatchObject({
      state: 'accepted',
      operationSnapshot: { state: 'succeeded' },
    })
    expect(test.operations.validateDurableState(new Set(), test.registry).runningAgentRuns).toHaveLength(1)
  })

  it('stops startup before Intent replay when a proven running Run cannot resume', async () => {
    const test = harness()
    const submitted = intent('intent-39393939-3939-4939-8939-393939393939' as SakiControlIntentId)
    await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
    const retainedIntent = only(test.intents)
    test.intents.records.set(retainedIntent.id, agentOperationIntentRecordSchema.parse({
      ...retainedIntent,
      phase: 'dispatching',
    }))
    const retainedAssignment = only(test.assignments)
    test.assignments.records.set(retainedAssignment.id, workAssignmentRecordSchema.parse({
      ...retainedAssignment,
      state: 'assigned',
    }))
    test.moves.splice(0)
    const state = test.operations.validateDurableState(new Set(), test.registry)
    expect(state.runningAgentRuns).toHaveLength(1)
    test.execution.resumeError = new Error('simulated running Agent resume failure')

    await expect(test.operations.initializeValidated(state))
      .rejects.toThrow('simulated running Agent resume failure')
    expect(test.execution.resumeCount).toBe(1)
    expect(test.moves).toHaveLength(0)
    expect(only(test.intents)).toMatchObject({ phase: 'dispatching' })
    expect(only(test.assignments)).toMatchObject({ state: 'assigned' })
  })

  it.each(['lost reply', 'aborted caller'] as const)(
    'finds and cancels a durable Host preparation after a %s and later revocation',
    async (interruption) => {
      const test = harness()
      const submitted = intent('intent-31313131-3131-4131-8131-313131313131' as SakiControlIntentId)
      const interrupted = new AbortController()
      test.execution.afterPrepare = () => {
        if (interruption === 'lost reply') throw new Error('simulated prepare reply loss')
        interrupted.abort()
      }

      await expect(test.operations.submit(submitted, actor(), interrupted.signal)).rejects.toThrow()
      const interruptedDispatch = only(test.dispatches)
      expect(interruptedDispatch).toMatchObject({ state: 'claimed' })
      expect(interruptedDispatch.preparation).toBeUndefined()
      expect(interruptedDispatch.operationSnapshot).toBeUndefined()
      expect(test.execution.prepareCount).toBe(1)
      expect(test.execution.cancelCount).toBe(0)

      test.authorityCurrent = false
      expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))).toMatchObject({
        ok: false,
        reason: 'canceled',
        receipt: { state: 'canceled', reason: 'authority-revoked' },
      })
      expect(test.execution.prepareCount).toBe(2)
      expect(test.execution.cancelCount).toBe(1)
      expect(only(test.dispatches)).toMatchObject({
        state: 'canceled',
        operationSnapshot: { state: 'canceled', effect: 'none' },
      })
      expect(only(test.admissions)).toMatchObject({ state: 'available' })
      expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
      expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
        .toMatchObject({ ok: false, reason: 'canceled', receipt: { state: 'canceled' } })
      expect(test.execution.prepareCount).toBe(2)
      expect(test.execution.cancelCount).toBe(1)
    },
  )

  it('reconciles an unknown Host outcome and never starts a second Run', async () => {
    const test = harness()
    const submitted = intent('intent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as SakiControlIntentId)
    test.execution.startMode = 'reconciliation'

    const result = await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))

    expect(result).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'effect-unknown' },
    })
    expect(only(test.dispatches)).toMatchObject({
      state: 'reconciliation-required',
      terminalReason: 'effect-unknown',
    })
    expect(only(test.runs)).toMatchObject({ state: 'reconciliation-required' })
    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))).toEqual(result)
    expect(test.execution.startCount).toBe(1)
    expect(test.execution.prepareCount).toBe(2)
    expect(test.runs.size).toBe(1)
    expect(test.moves).toHaveLength(0)
  })

  it('preserves an accepted Dispatch while revoked Host cancellation proves no effect', async () => {
    const test = harness()
    const submitted = intent('intent-dddddddd-dddd-4ddd-8ddd-dddddddddddd' as SakiControlIntentId)
    test.execution.startMode = 'unavailable'

    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } })
    expect(only(test.dispatches)).toMatchObject({ state: 'accepted' })
    test.authorityCurrent = false

    const canceled = await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))

    expect(canceled).toMatchObject({ ok: false, reason: 'canceled', receipt: { state: 'canceled' } })
    expect(only(test.dispatches)).toMatchObject({
      state: 'accepted',
      acceptedFencingToken: 1,
      operationSnapshot: {
        state: 'canceled',
        reason: 'authority-revoked',
        effect: 'none',
      },
    })
    expect(only(test.assignments)).toMatchObject({ state: 'canceled' })
    expect(only(test.sessions)).toMatchObject({ state: 'canceled' })
    expect(only(test.runs)).toMatchObject({ state: 'canceled' })
    expect(only(test.admissions)).toMatchObject({ state: 'available' })
    expect(test.execution.cancelCount).toBe(1)
    expect(test.runs.size).toBe(1)
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
  })

  it('retains the accepted Run owner when Host cancellation cannot drain it', async () => {
    const test = harness()
    const submitted = intent('intent-32323232-3232-4232-8232-323232323232' as SakiControlIntentId)
    test.execution.startMode = 'unavailable'
    await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
    test.authorityCurrent = false
    test.execution.cancelError = new Error('simulated Host handle drain failure')

    await expect(test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow('simulated Host handle drain failure')
    expect(only(test.intents)).toMatchObject({ phase: 'dispatching' })
    expect(only(test.dispatches)).toMatchObject({ state: 'accepted' })
    expect(only(test.assignments)).toMatchObject({ state: 'assigned' })
    expect(only(test.sessions)).toMatchObject({ state: 'open' })
    expect(only(test.runs)).toMatchObject({ state: 'starting' })
    expect(only(test.admissions)).toMatchObject({ state: 'agent-run', phase: 'accepted' })
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
  })

  it('preserves a proven running Run when the in-progress move needs reconciliation', async () => {
    const test = harness()
    test.moveMode = 'reconciliation'
    const submitted = intent('intent-cccccccc-cccc-4ccc-8ccc-cccccccccccc' as SakiControlIntentId)

    const result = await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))

    expect(result).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'effect-unknown' },
    })
    expect(only(test.runs)).toMatchObject({ state: 'running', hostResult: { type: 'start-agent-run' } })
    expect(only(test.dispatches)).toMatchObject({
      state: 'reconciliation-required',
      operationSnapshot: { state: 'succeeded' },
    })
    const validated = test.operations.validateDurableState(new Set(), test.registry)
    expect(validated.runningAgentRuns).toEqual([{
      operation: only(test.dispatches).preparation?.operation,
      request: only(test.dispatches).hostRequest,
    }])
    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))).toEqual(result)
    expect(test.execution.startCount).toBe(1)
    expect(test.runs.size).toBe(1)
  })

  it('rejects tampering with the frozen Work Item and Profile context', async () => {
    const test = harness()
    const result = await test.operations.submit(
      intent('intent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SakiControlIntentId),
      actor(),
      AbortSignal.timeout(5_000),
    )
    if (!result.ok) throw new Error('test Agent operation did not start')
    const retained = only(test.intents)

    expect(agentOperationIntentRecordSchema.safeParse({
      ...retained,
      workItemDefinition: { ...retained.workItemDefinition, body: 'changed after acceptance' },
    }).success).toBe(false)
    expect(agentOperationIntentRecordSchema.safeParse({
      ...retained,
      profile: { ...retained.profile, agentPresetId: 'another-preset' },
    }).success).toBe(false)
  })

  it('rejects extra schema-valid children that reuse an existing Intent id', async () => {
    const cases = [
      (test: Harness) => {
        const retained = only(test.assignments)
        const id = 'assignment-12121212-1212-4212-8212-121212121212' as SakiWorkAssignmentId
        test.assignments.records.set(id, workAssignmentRecordSchema.parse({ ...retained, id }))
      },
      (test: Harness) => {
        const retained = only(test.sessions)
        const id = 'work-session-13131313-1313-4313-8313-131313131313' as SakiWorkSessionId
        test.sessions.records.set(id, workSessionRecordSchema.parse({ ...retained, id }))
      },
      (test: Harness) => {
        const retained = only(test.runs)
        const id = 'agent-run-14141414-1414-4414-8414-141414141414' as SakiAgentRunId
        test.runs.records.set(id, agentRunRecordSchema.parse({ ...retained, id }))
      },
      (test: Harness) => {
        const retained = only(test.dispatches)
        const id = 'dispatch-15151515-1515-4515-8515-151515151515' as SakiExecutionDispatchId
        const input = {
          ...retained.hostRequest.run.input,
          source: { ...retained.hostRequest.run.input.source, dispatchId: id },
        }
        const payloadDigest = computeStartAgentRunPayloadDigest(input)
        const hostRequest = startAgentRunHostOperationRequestSchema.parse({
          ...retained.hostRequest,
          source: { ...retained.hostRequest.source, dispatchId: id, payloadDigest },
          run: { ...retained.hostRequest.run, input },
        })
        test.dispatches.records.set(id, executionDispatchRecordSchema.parse({
          ...retained,
          id,
          payloadDigest,
          hostRequest,
        }))
      },
    ]
    for (const [index, addExtraChild] of cases.entries()) {
      const test = harness()
      test.execution.prepareMode = 'unavailable'
      await test.operations.submit(
        intent(`intent-16161616-1616-4616-8616-${String(index).padStart(12, '0')}` as SakiControlIntentId),
        actor(),
        AbortSignal.timeout(5_000),
      )
      addExtraChild(test)

      expect(() => test.operations.validateDurableState(new Set(), test.registry))
        .toThrow(/orphan or mismatched/u)
    }
  })

  it('rejects every schema-valid mutation of preallocated child ownership', async () => {
    const mutations: readonly (readonly [string, (test: Harness) => void])[] = [
      ['Assignment project', (test) => {
        const retained = only(test.assignments)
        test.assignments.records.set(retained.id, workAssignmentRecordSchema.parse({
          ...retained,
          projectId: 'project-12121212-1212-4212-8212-121212121212',
        }))
      }],
      ['Assignment Work Item', (test) => {
        const retained = only(test.assignments)
        test.assignments.records.set(retained.id, workAssignmentRecordSchema.parse({
          ...retained,
          workItemId: `work-item-${'1'.repeat(64)}`,
        }))
      }],
      ['Work Session project', (test) => {
        const retained = only(test.sessions)
        test.sessions.records.set(retained.id, workSessionRecordSchema.parse({
          ...retained,
          projectId: 'project-13131313-1313-4313-8313-131313131313',
        }))
      }],
      ['Work Session Work Item', (test) => {
        const retained = only(test.sessions)
        test.sessions.records.set(retained.id, workSessionRecordSchema.parse({
          ...retained,
          workItemId: `work-item-${'2'.repeat(64)}`,
        }))
      }],
      ['Work Session Run list', (test) => {
        const retained = only(test.sessions)
        test.sessions.records.set(retained.id, workSessionRecordSchema.parse({
          ...retained,
          agentRunIds: [
            ...retained.agentRunIds,
            'agent-run-14141414-1414-4414-8414-141414141414',
          ],
        }))
      }],
      ['Agent Run project', (test) => {
        const retained = only(test.runs)
        test.runs.records.set(retained.id, agentRunRecordSchema.parse({
          ...retained,
          projectId: 'project-15151515-1515-4515-8515-151515151515',
        }))
      }],
      ['Agent Run Work Item', (test) => {
        const retained = only(test.runs)
        test.runs.records.set(retained.id, agentRunRecordSchema.parse({
          ...retained,
          workItemId: `work-item-${'3'.repeat(64)}`,
        }))
      }],
      ['Agent Run Binding', (test) => {
        const retained = only(test.runs)
        test.runs.records.set(retained.id, agentRunRecordSchema.parse({
          ...retained,
          bindingId: 'binding-16161616-1616-4616-8616-161616161616',
        }))
      }],
      ['Agent Run Profile', (test) => {
        const retained = only(test.runs)
        test.runs.records.set(retained.id, agentRunRecordSchema.parse({
          ...retained,
          profile: { ...retained.profile, agentPresetId: 'alternate-development' },
        }))
      }],
      ['Agent Run Session', (test) => {
        const retained = only(test.runs)
        test.runs.records.set(retained.id, agentRunRecordSchema.parse({
          ...retained,
          sessionId: 'session-17171717-1717-4717-8717-171717171717',
        }))
      }],
      ['Agent Run input plan', (test) => {
        const retained = only(test.runs)
        test.runs.records.set(retained.id, agentRunRecordSchema.parse({
          ...retained,
          inputPlan: { ...retained.inputPlan, payloadDigest: '8'.repeat(64) },
        }))
      }],
      ['Agent Run Dispatch list', (test) => {
        const retained = only(test.runs)
        test.runs.records.set(retained.id, agentRunRecordSchema.parse({
          ...retained,
          dispatchIds: [
            ...retained.dispatchIds,
            'dispatch-18181818-1818-4818-8818-181818181818',
          ],
        }))
      }],
      ['Execution Dispatch Host before preparation', (test) => {
        const retained = only(test.dispatches)
        test.dispatches.records.set(retained.id, executionDispatchRecordSchema.parse({
          ...retained,
          hostId: 'host-19191919-1919-4919-8919-191919191919',
        }))
      }],
      ...(['assignment', 'session', 'run', 'dispatch'] as const).map(kind => [
        `${kind} creation time`,
        (test: Harness) => {
          const table = kind === 'assignment'
            ? test.assignments
            : kind === 'session'
              ? test.sessions
              : kind === 'run'
                ? test.runs
                : test.dispatches
          const retained = only(table as unknown as MemoryTable<
            string,
            { readonly id: string; readonly createdAt: number }
          >)
          const candidate = { ...retained, createdAt: retained.createdAt - 1 }
          if (kind === 'assignment') {
            test.assignments.records.set(retained.id as SakiWorkAssignmentId, workAssignmentRecordSchema.parse(candidate))
          } else if (kind === 'session') {
            test.sessions.records.set(retained.id as SakiWorkSessionId, workSessionRecordSchema.parse(candidate))
          } else if (kind === 'run') {
            test.runs.records.set(retained.id as SakiAgentRunId, agentRunRecordSchema.parse(candidate))
          } else {
            test.dispatches.records.set(retained.id as SakiExecutionDispatchId, executionDispatchRecordSchema.parse(candidate))
          }
        },
      ] as const),
    ]
    for (const [description, mutate] of mutations) {
      const test = harness()
      test.execution.prepareMode = 'unavailable'
      await test.operations.submit(
        intent('intent-24242424-2424-4424-8424-242424242424' as SakiControlIntentId),
        actor(),
        AbortSignal.timeout(5_000),
      )
      mutate(test)

      expect(
        () => test.operations.validateDurableState(new Set(), test.registry),
        description,
      ).toThrow(/disagrees|mismatched/u)
    }
  })

  it('accepts started only with the exact active child lifecycle and succeeded Host result', async () => {
    const mutations: readonly (readonly [string, (test: Harness) => void])[] = [
      ['assigned Assignment', (test) => {
        const retained = only(test.assignments)
        test.assignments.records.set(retained.id, workAssignmentRecordSchema.parse({
          ...retained,
          state: 'assigned',
        }))
      }],
      ['terminal Work Session', (test) => {
        const retained = only(test.sessions)
        test.sessions.records.set(retained.id, workSessionRecordSchema.parse({
          ...retained,
          state: 'reconciliation-required',
        }))
      }],
      ['allocated Agent Run', (test) => {
        const retained = only(test.runs)
        test.runs.records.set(retained.id, agentRunRecordSchema.parse({
          ...retained,
          state: 'allocated',
          hostResult: undefined,
        }))
      }],
      ['reconciling Dispatch', (test) => {
        const retained = only(test.dispatches)
        test.dispatches.records.set(retained.id, executionDispatchRecordSchema.parse({
          ...retained,
          state: 'reconciliation-required',
          terminalReason: 'protocol',
        }))
      }],
      ['missing Host completion', (test) => {
        const retained = only(test.dispatches)
        test.dispatches.records.set(retained.id, executionDispatchRecordSchema.parse({
          ...retained,
          operationSnapshot: undefined,
        }))
      }],
      ['different Host result', (test) => {
        const retained = only(test.dispatches)
        const snapshot = retained.operationSnapshot
        if (snapshot?.state !== 'succeeded') throw new Error('test Dispatch lacks succeeded Host evidence')
        test.dispatches.records.set(retained.id, executionDispatchRecordSchema.parse({
          ...retained,
          operationSnapshot: {
            ...snapshot,
            result: {
              ...snapshot.result,
              agentRunId: 'agent-run-25252525-2525-4525-8525-252525252525',
            },
          },
        }))
      }],
    ]
    for (const [description, mutate] of mutations) {
      const test = harness()
      await test.operations.submit(
        intent('intent-26262626-2626-4626-8626-262626262626' as SakiControlIntentId),
        actor(),
        AbortSignal.timeout(5_000),
      )
      mutate(test)

      expect(
        () => test.operations.validateDurableState(new Set(), test.registry),
        description,
      ).toThrow('started Saki Agent operation has an inconsistent child lifecycle')
    }
  })

  it('accepts reconciliation only with terminal children or a proven running Run', async () => {
    const mutations: readonly (readonly [string, (test: Harness) => void])[] = [
      ['assigned Assignment', (test) => {
        const retained = only(test.assignments)
        test.assignments.records.set(retained.id, workAssignmentRecordSchema.parse({
          ...retained,
          state: 'assigned',
        }))
      }],
      ['open Work Session', (test) => {
        const retained = only(test.sessions)
        test.sessions.records.set(retained.id, workSessionRecordSchema.parse({
          ...retained,
          state: 'open',
        }))
      }],
      ['accepted Dispatch', (test) => {
        const retained = only(test.dispatches)
        test.dispatches.records.set(retained.id, executionDispatchRecordSchema.parse({
          ...retained,
          state: 'accepted',
          terminalReason: undefined,
        }))
      }],
      ['allocated Agent Run', (test) => {
        const retained = only(test.runs)
        test.runs.records.set(retained.id, agentRunRecordSchema.parse({
          ...retained,
          state: 'allocated',
        }))
      }],
      ['unproven running Agent Run', (test) => {
        const retained = only(test.runs)
        const request = only(test.dispatches).hostRequest
        test.runs.records.set(retained.id, agentRunRecordSchema.parse({
          ...retained,
          state: 'running',
          hostResult: {
            type: 'start-agent-run',
            agentRunId: retained.id,
            workSessionId: retained.workSessionId,
            sessionId: retained.sessionId,
            inputMessageId: request.run.input.id,
          },
        }))
      }],
    ]
    for (const [description, mutate] of mutations) {
      const test = harness()
      test.execution.startMode = 'reconciliation'
      await test.operations.submit(
        intent('intent-27272727-2727-4727-8727-272727272727' as SakiControlIntentId),
        actor(),
        AbortSignal.timeout(5_000),
      )
      mutate(test)

      expect(
        () => test.operations.validateDurableState(new Set(), test.registry),
        description,
      ).toThrow('reconciling Saki Agent operation has an inconsistent child lifecycle')
    }
  })

  it.each([
    ['Dispatch', 0],
    ['Assignment', 1],
    ['Work Session', 2],
    ['Agent Run', 3],
    ['Intent', 4],
  ] as const)('recovers reconciliation after the %s terminal write committed', async (_boundary, stage) => {
    const test = harness()
    test.execution.startMode = 'reconciliation'
    const submitted = intent('intent-29292929-2929-4929-8929-292929292929' as SakiControlIntentId)
    await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))

    if (stage < 4) {
      const retained = only(test.intents)
      test.intents.records.set(retained.id, agentOperationIntentRecordSchema.parse({
        ...retained,
        phase: 'dispatching',
        terminalReason: undefined,
      }))
    }
    const assignment = only(test.assignments)
    test.assignments.records.set(assignment.id, workAssignmentRecordSchema.parse({
      ...assignment,
      state: stage >= 1 ? 'reconciliation-required' : 'assigned',
    }))
    const session = only(test.sessions)
    test.sessions.records.set(session.id, workSessionRecordSchema.parse({
      ...session,
      state: stage >= 2 ? 'reconciliation-required' : 'open',
    }))
    const run = only(test.runs)
    test.runs.records.set(run.id, agentRunRecordSchema.parse({
      ...run,
      state: stage >= 3 ? 'reconciliation-required' : 'starting',
    }))

    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'effect-unknown' },
    })
    expect(test.execution.startCount).toBe(1)
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
  })

  it.each([
    ['Dispatch', 0],
    ['Assignment', 1],
    ['Work Session', 2],
    ['Agent Run', 3],
    ['write admission', 4],
    ['Intent', 5],
  ] as const)('recovers accepted cancellation after the %s terminal write committed', async (_boundary, stage) => {
    const test = harness()
    test.execution.startMode = 'unavailable'
    const submitted = intent('intent-30303030-3030-4030-8030-303030303030' as SakiControlIntentId)
    await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
    const retainedAdmission = only(test.admissions)
    if (retainedAdmission.state !== 'agent-run' || retainedAdmission.phase !== 'accepted') {
      throw new Error('test Agent Run does not own accepted write admission')
    }
    test.authorityCurrent = false
    await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))

    if (stage < 5) {
      const retained = only(test.intents)
      test.intents.records.set(retained.id, agentOperationIntentRecordSchema.parse({
        ...retained,
        phase: 'dispatching',
        terminalReason: undefined,
      }))
    }
    const assignment = only(test.assignments)
    test.assignments.records.set(assignment.id, workAssignmentRecordSchema.parse({
      ...assignment,
      state: stage >= 1 ? 'canceled' : 'assigned',
    }))
    const session = only(test.sessions)
    test.sessions.records.set(session.id, workSessionRecordSchema.parse({
      ...session,
      state: stage >= 2 ? 'canceled' : 'open',
    }))
    const run = only(test.runs)
    test.runs.records.set(run.id, agentRunRecordSchema.parse({
      ...run,
      state: stage >= 3 ? 'canceled' : 'starting',
    }))
    if (stage < 4) test.admissions.records.set(BINDING_ID, retainedAdmission)

    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'canceled',
      receipt: { state: 'canceled', reason: 'authority-revoked' },
    })
    expect(test.execution.cancelCount).toBe(1)
    expect(only(test.dispatches)).toMatchObject({
      state: 'accepted',
      operationSnapshot: { state: 'canceled', effect: 'none' },
    })
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
  })

  it.each([
    ['too many acceptance criteria', () => [
      '# Intended outcome',
      'Ship the vertical slice.',
      '# Acceptance criteria',
      ...Array.from({ length: 129 }, (_, index) => `- criterion ${String(index)}`),
    ].join('\n')],
    ['one oversized acceptance criterion', () => [
      '# Intended outcome',
      'Ship the vertical slice.',
      '# Acceptance criteria',
      `- ${'c'.repeat(4_097)}`,
    ].join('\n')],
    ['an oversized intended outcome', () => [
      '# Intended outcome',
      'o'.repeat(32_769),
      '# Acceptance criteria',
      '- remains bounded',
    ].join('\n')],
    ['a legal Issue body whose rendered input exceeds the UTF-8 budget', () => [
      '# Intended outcome',
      'o'.repeat(32_768),
      '# Acceptance criteria',
      ...Array.from({ length: 56 }, (_, index) => `- ${String(index).padStart(2, '0')} ${'c'.repeat(4_088)}`),
    ].join('\n')],
  ])('rejects %s before persisting an Agent operation', async (_description, body) => {
    const test = harness()
    test.issueBody = body()
    expect(new TextEncoder().encode(test.issueBody).byteLength)
      .toBeLessThanOrEqual(MAX_START_AGENT_RUN_INPUT_UTF8_BYTES)

    const result = await test.operations.submit(
      intent('intent-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as SakiControlIntentId),
      actor(),
      AbortSignal.timeout(5_000),
    )

    expect(result).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'work-item-detail-unavailable',
    })
    expect(test.intents.size).toBe(0)
    expect(test.assignments.size).toBe(0)
    expect(test.sessions.size).toBe(0)
    expect(test.runs.size).toBe(0)
    expect(test.dispatches.size).toBe(0)
    expect(only(test.admissions)).toMatchObject({ state: 'available', revision: 0 })
  })
})

class SimulatedProcessCrash extends Error {}

class MemoryTable<K extends string, V> implements KvTable<K, V> {
  readonly records = new Map<K, V>()
  beforeNextUpdate: (() => void) | undefined
  afterNextUpdate: (() => void | Promise<void>) | undefined
  private crashAfterPut: ((value: V) => boolean) | undefined
  private crashAfterUpdate: ((value: V) => boolean) | undefined
  private crashReads = 0

  constructor(entries: readonly (readonly [K, V])[] = []) {
    for (const [key, value] of entries) this.records.set(key, value)
  }

  get size(): number { return this.records.size }
  get(key: K): V | undefined {
    if (this.crashReads > 0) {
      this.crashReads -= 1
      throw new SimulatedProcessCrash('process stopped after a committed table write')
    }
    return this.records.get(key)
  }
  entries(): IterableIterator<[K, V]> { return new Map(this.records).entries() }
  keys(): IterableIterator<K> { return new Map(this.records).keys() }
  async put(key: K, value: V): Promise<void> {
    this.records.set(key, value)
    if (this.crashAfterPut?.(value) === true) {
      this.crashAfterPut = undefined
      this.crashReads = 1
      throw new SimulatedProcessCrash('storage put committed before the process stopped')
    }
  }
  async delete(key: K): Promise<boolean> { return this.records.delete(key) }

  async update(key: K, update: (current: V) => V): Promise<V> {
    const beforeNextUpdate = this.beforeNextUpdate
    this.beforeNextUpdate = undefined
    beforeNextUpdate?.()
    const current = this.records.get(key)
    if (current === undefined) throw new Error('missing-key')
    const next = update(current)
    this.records.set(key, next)
    if (this.crashAfterUpdate?.(next) === true) {
      this.crashAfterUpdate = undefined
      this.crashReads = 1
      throw new SimulatedProcessCrash('storage update committed before the process stopped')
    }
    const afterNextUpdate = this.afterNextUpdate
    this.afterNextUpdate = undefined
    await afterNextUpdate?.()
    return next
  }

  simulateCrashAfterPutWhen(predicate: (value: V) => boolean): void {
    this.crashAfterPut = predicate
  }

  simulateCrashAfterUpdateWhen(predicate: (value: V) => boolean): void {
    this.crashAfterUpdate = predicate
  }
}

class TestAcceptance extends HostOperationAcceptance {
  constructor(readonly operationId: string) { super() }
}

class FakeAgentExecution extends SakiHostExecution {
  prepareMode: 'success' | 'unavailable' = 'success'
  startMode: 'success' | 'reconciliation' | 'unavailable' = 'success'
  prepareCount = 0
  startCount = 0
  cancelCount = 0
  resumeCount = 0
  cancelError: Error | undefined
  resumeError: Error | undefined
  afterPrepare: (() => void) | undefined
  afterStart: (() => void) | undefined
  request: StartAgentRunHostOperationRequest | undefined
  private admission: HostOperationAdmissionSource | undefined
  private preparation: HostOperationPreparation<'start-agent-run'> | undefined
  private snapshot: HostOperationSnapshot<'start-agent-run'> | undefined
  private readonly acceptance = new TestAcceptance('agent-operation-test')

  constructor(private readonly project: InspectProjectResult) { super(new Context()) }

  async inspectProjectSelection(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
    return { ok: false, reason: 'unavailable' }
  }

  async inspectProject(): Promise<InspectProjectResult> { return this.project }
  async readDiff(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
    return { ok: false, reason: 'unavailable' }
  }

  async prepareOperation<K extends HostOperationKind>(
    request: HostOperationRequest<K>,
    admission: HostOperationAdmissionSource,
    signal: AbortSignal,
  ): Promise<HostOperationReceipt<K>>
  async prepareOperation(
    request: HostOperationRequest,
    admission: HostOperationAdmissionSource,
    signal: AbortSignal,
  ): Promise<HostOperationReceipt> {
    this.prepareCount += 1
    signal.throwIfAborted()
    if (this.prepareMode === 'unavailable') return { ok: false, reason: 'unavailable' }
    if (request.type !== 'start-agent-run') return { ok: false, reason: 'unavailable' }
    const parsed = startAgentRunHostOperationRequestSchema.parse(request)
    if (this.request !== undefined && !sameRequest(this.request, parsed)) {
      return { ok: false, reason: 'source-conflict' }
    }
    this.request = parsed
    this.admission = admission
    if (this.preparation === undefined || this.snapshot === undefined) {
      const operation = {
        id: parsed.source.dispatchId.replace(/^dispatch-/u, 'host-operation-'),
        hostId: parsed.expected.binding.hostId,
        type: 'start-agent-run',
      } as HostOperationReference<'start-agent-run'>
      const requestFingerprint = {
        version: 1 as const,
        digest: canonicalDigest('saki/test-agent-host-request/v1', parsed),
      }
      this.preparation = { operation, preparationRevision: 0, requestFingerprint }
      this.snapshot = {
        operation,
        revision: 0,
        source: parsed.source,
        requestFingerprint,
        bindingId: parsed.expected.binding.id,
        bindingRevision: parsed.expected.binding.revision,
        preparedAt: 1,
        updatedAt: 1,
        state: 'prepared',
        admission: { kind: 'not-accepted' },
      }
    }
    const afterPrepare = this.afterPrepare
    this.afterPrepare = undefined
    afterPrepare?.()
    return {
      ok: true,
      preparation: this.preparation,
      snapshot: this.snapshot,
      acceptance: this.acceptance,
    }
  }

  async startOperation<K extends HostOperationKind>(
    _operation: HostOperationReference<K>,
    _acceptance: HostOperationAcceptance,
    signal: AbortSignal,
  ): Promise<HostOperationStartResult<K>> {
    this.startCount += 1
    signal.throwIfAborted()
    if (this.startMode === 'unavailable') {
      return { ok: false, reason: 'unavailable', snapshot: this.requireSnapshot() } as HostOperationStartResult<K>
    }
    const request = this.requireRequest()
    const preparation = this.requirePreparation()
    const admission = this.admission
    if (admission === undefined) throw new Error('test Host admission callback is absent')
    const decision = await admission({
      bindingId: request.expected.binding.id,
      bindingRevision: request.expected.binding.revision,
      preparation,
      source: request.source,
    }, signal)
    if (decision.kind !== 'accepted') {
      return {
        ok: false,
        reason: decision.kind === 'unavailable' ? 'unavailable' : decision.reason,
        snapshot: this.requireSnapshot(),
      } as HostOperationStartResult<K>
    }
    const common = {
      operation: preparation.operation,
      revision: 1,
      source: request.source,
      requestFingerprint: preparation.requestFingerprint,
      bindingId: request.expected.binding.id,
      bindingRevision: request.expected.binding.revision,
      preparedAt: 1,
      updatedAt: 3,
      admission: { kind: 'accepted' as const, revision: decision.admissionRevision, acceptedAt: 2 },
    }
    this.snapshot = this.startMode === 'reconciliation'
      ? {
        ...common,
        state: 'reconciliation-required',
        observedAt: 3,
        reason: 'effect-unknown',
      }
      : {
        ...common,
        state: 'succeeded',
        completedAt: 3,
        result: {
          type: 'start-agent-run',
          agentRunId: request.run.agentRunId,
          workSessionId: request.run.workSessionId,
          sessionId: request.run.sessionId,
          inputMessageId: request.run.input.id,
        },
      }
    const afterStart = this.afterStart
    this.afterStart = undefined
    afterStart?.()
    return { ok: true, snapshot: this.snapshot } as HostOperationStartResult<K>
  }

  async inspectOperation<K extends HostOperationKind>(): Promise<HostOperationSnapshot<K>> {
    return this.requireSnapshot() as HostOperationSnapshot<K>
  }

  async resumeAgentRun(
    _operation: HostOperationReference<'start-agent-run'>,
    _request: StartAgentRunHostOperationRequest,
    signal: AbortSignal,
  ): Promise<void> {
    this.resumeCount += 1
    signal.throwIfAborted()
    if (this.resumeError !== undefined) throw this.resumeError
  }

  async cancelOperation<K extends HostOperationKind>(
    _operation: HostOperationReference<K>,
    reason: HostOperationCancellationReason,
  ): Promise<HostOperationSnapshot<K>> {
    this.cancelCount += 1
    if (this.cancelError !== undefined) throw this.cancelError
    const current = this.requireSnapshot()
    this.snapshot = {
      ...current,
      revision: current.revision + 1,
      state: 'canceled',
      admission: current.admission,
      updatedAt: 4,
      completedAt: 4,
      reason,
      effect: 'none',
    }
    return this.snapshot as HostOperationSnapshot<K>
  }

  onChanged(_listener: (change: HostOperationChange) => void): () => void { return () => {} }

  private requireRequest(): StartAgentRunHostOperationRequest {
    if (this.request === undefined) throw new Error('test Host request is absent')
    return this.request
  }

  private requirePreparation(): HostOperationPreparation<'start-agent-run'> {
    if (this.preparation === undefined) throw new Error('test Host preparation is absent')
    return this.preparation
  }

  private requireSnapshot(): HostOperationSnapshot<'start-agent-run'> {
    if (this.snapshot === undefined) throw new Error('test Host snapshot is absent')
    return this.snapshot
  }
}

const PROJECT = SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace.project
const PROJECT_ID = PROJECT.id
const BINDING_ID = PROJECT.binding.id
const HOST_ID = PROJECT.binding.hostId
const WORKSPACE_ID = SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace.currentSelection.workspaceId!
const PROFILE_ID = 'agent-profile-11111111-1111-4111-8111-111111111111' as const
const INSTALLATION_ID = 'installation-22222222-2222-4222-8222-222222222222' as SakiInstallationId
const STORAGE_GENERATION_ID = 'storage-generation-33333333-3333-4333-8333-333333333333' as SakiStorageGenerationId
const PRINCIPAL_ID = 'principal-44444444-4444-4444-8444-444444444444' as SakiPrincipalId
const GRANT_ID = 'grant-55555555-5555-4555-8555-555555555555' as SakiGrantId
const TRUSTED = {
  canonicalWorktreePath: '/fixture/repository',
  canonicalGitDirectory: '/fixture/repository/.git',
  canonicalCommonGitDirectory: '/fixture/repository/.git',
  gitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
  commonGitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
  comparison: { fileMode: true, symlinks: true, autocrlf: false },
} as const

interface Harness {
  readonly operations: AgentOperations
  readonly intents: MemoryTable<SakiControlIntentId, AgentOperationIntentRecord>
  readonly assignments: MemoryTable<SakiWorkAssignmentId, WorkAssignmentRecord>
  readonly sessions: MemoryTable<SakiWorkSessionId, WorkSessionRecord>
  readonly runs: MemoryTable<SakiAgentRunId, AgentRunRecord>
  readonly dispatches: MemoryTable<SakiExecutionDispatchId, ExecutionDispatchRecord>
  readonly admissions: MemoryTable<SakiResourceBindingId, BindingWriteAdmissionRecord>
  readonly execution: FakeAgentExecution
  readonly registry: DevelopmentProjectRegistryRecord
  readonly moves: MoveWorkItemIntent[]
  readonly resolvedModelRoutes: { readonly provider: string; readonly model: string }[]
  restart(): void
  moveMode: 'success' | 'reconciliation'
  authorityCurrent: boolean
  bindingCurrent: boolean
  modelRouteAvailable: boolean
  issueBody: string
}

function harness(): Harness {
  const board = SAKI_BOARD_PROJECTION_FIXTURES.confirmedStaleFailure.confirmed
  const active = SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES.activated.synchronization.active
  const item = board?.items[0]
  if (board === undefined || active === undefined || item === undefined) {
    throw new Error('Agent operation fixtures are incomplete')
  }
  const registration = { projection: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection, trusted: TRUSTED }
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
      revision: PROJECT.revision,
      projectTitle: PROJECT.projectTitle,
      resourceBindingId: BINDING_ID,
      defaultAgentProfileId: PROFILE_ID,
      state: 'active',
      createdAt: 1,
    }],
    resourceBindings: [resource],
    agentProfiles: [{
      id: PROFILE_ID,
      projectId: PROJECT_ID,
      version: 1,
      agentPresetId: 'development',
      modelRouteRequest: { provider: 'test-provider', model: 'test-model' },
      createdAt: 1,
    }],
    canonicalWorktreeIndex: [{
      hostId: HOST_ID,
      path: TRUSTED.canonicalWorktreePath,
      resourceBindingId: BINDING_ID,
    }],
    gitDirectoryIndex: [{
      hostId: HOST_ID,
      path: TRUSTED.canonicalGitDirectory,
      resourceBindingId: BINDING_ID,
    }],
    intentMappings: [],
  })
  const observationResult = SAKI_GIT_CHANGES_PROJECTION_FIXTURES.clean.result
  if (!observationResult.ok) throw new Error('clean Git fixture is unavailable')
  const execution = new FakeAgentExecution({
    ok: true,
    observation: observationResult.observation,
    preEffectBaseline: baseline,
  })
  const intents = new MemoryTable<SakiControlIntentId, AgentOperationIntentRecord>()
  const assignments = new MemoryTable<SakiWorkAssignmentId, WorkAssignmentRecord>()
  const sessions = new MemoryTable<SakiWorkSessionId, WorkSessionRecord>()
  const runs = new MemoryTable<SakiAgentRunId, AgentRunRecord>()
  const dispatches = new MemoryTable<SakiExecutionDispatchId, ExecutionDispatchRecord>()
  const admissions = new MemoryTable<SakiResourceBindingId, BindingWriteAdmissionRecord>([[
    BINDING_ID,
    bindingWriteAdmissionRecordSchema.parse({
      id: BINDING_ID,
      schemaVersion: 1,
      revision: 0,
      state: 'available',
      updatedAt: 1,
    }),
  ]])
  const moves: MoveWorkItemIntent[] = []
  const resolvedModelRoutes: { provider: string; model: string }[] = []
  const state: Pick<Harness, 'moveMode' | 'authorityCurrent' | 'bindingCurrent' | 'modelRouteAvailable' | 'issueBody'> = {
    moveMode: 'success',
    authorityCurrent: true,
    bindingCurrent: true,
    modelRouteAvailable: true,
    issueBody: [
      '# Intended outcome',
      'Ship the vertical slice.',
      '# Acceptance criteria',
      '- Delivers the exact input once',
      '- Moves to in-progress after the Run exists',
      '# Blocked by',
      'None',
    ].join('\n'),
  }
  const createOperations = (): AgentOperations => {
    const candidate = new AgentOperations({
      intentTable: intents,
      assignmentTable: assignments,
      workSessionTable: sessions,
      agentRunTable: runs,
      dispatchTable: dispatches,
      admissionTable: admissions,
      execution,
      projects: {
        registry: () => registry,
        currentActiveBinding: () => state.bindingCurrent ? ({
          registryRevision: registry.revision,
          projectId: PROJECT_ID,
          projectRevision: PROJECT.revision,
          binding: activeHostProjectBinding(resource),
        }) : 'binding-unavailable',
      } as never,
      mutationContext: () => ({
        ok: true,
        context: {
          synchronizationRevision: 1,
          mappingRevision: 1,
          checkpointObservedAt: item.updatedAt,
          configuration: active.configuration,
          confirmedBoard: board,
        },
      }),
      authorityCurrent: () => state.authorityCurrent,
      validateActorReference: () => {},
      resolveModelRoute: async (route) => {
        resolvedModelRoutes.push(route)
        if (!state.modelRouteAvailable) throw new Error('test Model Route is unavailable')
      },
      moveWorkItem: async (move): Promise<SakiWorkItemIntentReceipt<'move-work-item'>> => {
        moves.push(move)
        if (state.moveMode === 'reconciliation') {
          return {
            ok: false,
            reason: 'reconciliation-required',
            receipt: {
              id: move.intentId.replace(/^intent-/u, 'receipt-') as never,
              intentId: move.intentId,
              type: 'move-work-item',
              projectId: move.projectId,
              state: 'reconciliation-required',
              reason: 'effect-unknown',
              workItemId: move.workItemId,
              stage: 'project-item-status-set',
            },
          }
        }
        return {
          ok: true,
          receipt: {
            id: move.intentId.replace(/^intent-/u, 'receipt-') as never,
            intentId: move.intentId,
            type: 'move-work-item',
            projectId: move.projectId,
            state: 'succeeded',
            workItemId: move.workItemId,
            issueNumber: item.issueNumber,
            url: item.url,
            remoteFingerprint: item.remoteFingerprint,
          },
        }
      },
      claimTtlMs: 30_000,
      notifyChanged: () => {},
      lifetime: new AbortController().signal,
    })
    candidate.attachGitHub({
      read: async (request: GitHubReadRequest) => request.kind === 'issue-detail'
        ? {
          id: item.source.issueId,
          repositoryId: item.source.repositoryId,
          repositoryDatabaseId: active.configuration.repositoryDatabaseId,
          number: item.issueNumber,
          state: item.issueState,
          title: item.title,
          url: item.url,
          updatedAt: item.updatedAt,
          body: state.issueBody,
        }
        : { kind: 'safe', branchExists: true, observedAt: item.updatedAt },
    } as never)
    return candidate
  }
  let operations = createOperations()
  return {
    get operations() { return operations },
    intents,
    assignments,
    sessions,
    runs,
    dispatches,
    admissions,
    execution,
    registry,
    moves,
    resolvedModelRoutes,
    restart() { operations = createOperations() },
    get moveMode() { return state.moveMode },
    set moveMode(value) { state.moveMode = value },
    get authorityCurrent() { return state.authorityCurrent },
    set authorityCurrent(value) { state.authorityCurrent = value },
    get bindingCurrent() { return state.bindingCurrent },
    set bindingCurrent(value) { state.bindingCurrent = value },
    get modelRouteAvailable() { return state.modelRouteAvailable },
    set modelRouteAvailable(value) { state.modelRouteAvailable = value },
    get issueBody() { return state.issueBody },
    set issueBody(value) { state.issueBody = value },
  }
}

function intent(intentId = 'intent-88888888-8888-4888-8888-888888888888' as SakiControlIntentId): GiveWorkItemToAgentIntent {
  const item = SAKI_BOARD_PROJECTION_FIXTURES.confirmedStaleFailure.confirmed?.items[0]
  if (item === undefined) throw new Error('confirmed Board fixture is absent')
  return {
    type: 'give-work-item-to-agent',
    intentId,
    projectId: PROJECT_ID,
    workItemId: item.id,
    expectedProjectRevision: PROJECT.revision,
    expectedRemoteFingerprint: item.remoteFingerprint,
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

function only<K extends string, V>(table: MemoryTable<K, V>): V {
  const values = [...table.records.values()]
  if (values.length !== 1) throw new Error(`expected one test record, received ${String(values.length)}`)
  return values[0]!
}

function sameRequest(left: StartAgentRunHostOperationRequest, right: StartAgentRunHostOperationRequest): boolean {
  return canonicalDigest('saki/test-agent-host-request-equality/v1', left)
    === canonicalDigest('saki/test-agent-host-request-equality/v1', right)
}
