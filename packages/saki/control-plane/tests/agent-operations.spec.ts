import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, vi } from 'vitest'
import { githubIssueId, githubRepositoryDatabaseId, githubRepositoryId } from '@breakfastdapaidang/saki-github'
import type { GitHubBranchSafetyFact, GitHubIssueDetailFact, GitHubReadRequest } from '@breakfastdapaidang/saki-github'
import {
  canonicalDigest,
  computeStartAgentRunPayloadDigest,
  HostOperationAcceptance,
  MAX_START_AGENT_RUN_INPUT_UTF8_BYTES,
  SakiHostExecution,
  startAgentRunHostOperationRequestSchema,
} from '@breakfastdapaidang/saki-execution'
import type {
  HostOperationAdmissionExpectation,
  HostOperationAdmissionSource,
  HostOperationCancellationReason,
  HostOperationChange,
  HostOperationId,
  HostOperationKind,
  HostOperationPreparation,
  HostOperationReceipt,
  HostOperationReference,
  HostOperationRequest,
  HostOperationSnapshot,
  HostOperationStartResult,
  InspectProjectResult,
  InterventionOpeningEvidence,
  StartAgentRunHostOperationRequest,
} from '@breakfastdapaidang/saki-execution'
import { AgentOperations } from '../src/agent-operations.ts'
import { SAKI_BOARD_MUTATION_OVERLAY_FIXTURES, SAKI_BOARD_PROJECTION_FIXTURES, SAKI_GIT_CHANGES_PROJECTION_FIXTURES, SAKI_PROJECT_PROJECTION_FIXTURES, SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES } from '../src/fixtures.ts'
import type { GitHubWorkItemMutationContextResult } from '../src/github-sync.ts'
import { activeHostProjectBinding } from '../src/projects.ts'
import {
  agentOperationIntentRecordSchema,
  agentRunRecordSchema,
  bindingWriteAdmissionRecordSchema,
  developmentProjectRegistryRecordSchema,
  executionDispatchRecordSchema,
  giveWorkItemToAgentIntentSchema,
  interventionRequestRecordSchema,
  MAX_INTERVENTION_PROMPT_CHARS,
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
  InterventionRequestRecord,
  WorkAssignmentRecord,
  WorkSessionRecord,
} from '../src/spec.ts'
import type {
  AnswerInterventionIntent,
  GiveWorkItemToAgentIntent,
  MoveWorkItemIntent,
  SakiAgentRunId,
  SakiBoardWorkItemProjection,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiExecutionDispatchId,
  SakiGrantId,
  SakiInstallationId,
  SakiInterventionRequestId,
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

  it('opens an Intervention and resumes the same Agent Run and Session with the attributed answer', async () => {
    const test = harness()
    const started = await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    expect(started).toMatchObject({ ok: true, receipt: { state: 'started' } })
    const initialRun = only(test.runs)

    const requested = await test.operations.requestIntervention({
      sessionId: initialRun.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_need_operator'),
      prompt: 'Which migration path should I use?',
    }, AbortSignal.timeout(5_000))
    if (!requested.ok) throw new Error('test Intervention was not created')
    expect(await test.operations.finalizeInterventionOpening(
      requested.interventionId,
      AbortSignal.timeout(5_000),
    )).toBe('open')
    const open = interventionRequestRecordSchema.parse(test.interventions.get(requested.interventionId))
    expect(open).toMatchObject({ state: 'open', targetPrincipalId: PRINCIPAL_ID })
    expect(only(test.runs)).toMatchObject({
      state: 'waiting',
      blockingInterventionId: requested.interventionId,
    })

    const dirty = SAKI_GIT_CHANGES_PROJECTION_FIXTURES.dirty.result
    if (!dirty.ok || !test.eligibility.projectInspection.ok) {
      throw new Error('test Git evidence is unavailable')
    }
    test.eligibility.projectInspection = {
      ...test.eligibility.projectInspection,
      observation: dirty.observation,
    }
    test.execution.beginNextOperation()
    const answer: AnswerInterventionIntent = {
      type: 'answer-intervention',
      intentId: 'intent-91919191-9191-4191-8191-919191919191' as SakiControlIntentId,
      interventionId: requested.interventionId,
      expectedInterventionRevision: open.revision,
      answer: { kind: 'text', text: 'Use the exact adjacent v7 to v8 migration.' },
    }
    const resolved = await test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000))

    expect(resolved).toMatchObject({ ok: true, receipt: { state: 'resolved' } })
    const resumedRun = only(test.runs)
    expect(resumedRun).toMatchObject({
      id: initialRun.id,
      sessionId: initialRun.sessionId,
      state: 'running',
    })
    expect(resumedRun.dispatchIds).toHaveLength(2)
    expect([...test.dispatches.records.values()].at(-1)?.hostRequest.run.input).toMatchObject({
      role: 'user',
      source: {
        kind: 'saki-intervention-answer',
        interventionId: requested.interventionId,
        answerIntentId: answer.intentId,
        agentRunId: initialRun.id,
        workSessionId: initialRun.workSessionId,
      },
    })
    expect([...test.dispatches.records.values()].at(-1)?.hostRequest.expected.status)
      .toEqual(dirty.observation.fingerprint)
    expect(interventionRequestRecordSchema.parse(test.interventions.get(requested.interventionId)))
      .toMatchObject({ state: 'resolved' })
    expect(only(test.admissions)).toMatchObject({ state: 'agent-run', phase: 'accepted' })
    const finalDispatch = [...test.dispatches.records.values()].at(-1)
    const validated = test.operations.validateDurableState(new Set(), test.registry)
    expect(validated.interventions).toHaveLength(1)
    expect(validated.openingInterventionIds).toEqual([])
    expect(validated.answerPendingInterventionIds).toEqual([])
    expect(validated.runningAgentRuns).toEqual([{
      operation: finalDispatch?.preparation?.operation,
      request: finalDispatch?.hostRequest,
    }])
  })

  it('admits an Intervention from the exact accepted initial Run while Host success is publishing', async () => {
    const test = harness()
    let releaseStart!: () => void
    let observeStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    const startObserved = new Promise<void>((resolve) => { observeStart = resolve })
    test.execution.afterStart = async () => {
      observeStart()
      await startGate
    }

    const submitting = test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    await startObserved
    const startingRun = only(test.runs)
    expect(startingRun).toMatchObject({ state: 'starting' })
    const requested = await test.operations.requestIntervention({
      sessionId: startingRun.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_during_initial_publication'),
      prompt: 'Which path should this accepted Agent Run take?',
    }, AbortSignal.timeout(5_000))
    if (!requested.ok) throw new Error('test Intervention was not created')
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
    const acceptedInitialDispatch = only(test.dispatches)
    test.dispatches.records.set(
      acceptedInitialDispatch.id,
      claimedDispatchForCorruption(acceptedInitialDispatch, 'dispatch-claim-11111111-2222-4111-8111-111111111111'),
    )
    expect(() => test.operations.validateDurableState(new Set(), test.registry))
      .toThrow('opening Saki Intervention disagrees with its Agent Run')
    test.dispatches.records.set(acceptedInitialDispatch.id, acceptedInitialDispatch)
    expect(await test.operations.finalizeInterventionOpening(
      requested.interventionId,
      AbortSignal.timeout(5_000),
    )).toBe('pending')

    let releaseRunning!: () => void
    let observeRunning!: () => void
    const runningGate = new Promise<void>((resolve) => { releaseRunning = resolve })
    const runningObserved = new Promise<void>((resolve) => { observeRunning = resolve })
    test.runs.afterNextUpdate = async () => {
      observeRunning()
      await runningGate
    }
    releaseStart()
    await runningObserved
    expect(only(test.runs)).toMatchObject({ state: 'running' })
    expect(only(test.assignments)).toMatchObject({ state: 'assigned' })
    expect(await test.operations.finalizeInterventionOpening(
      requested.interventionId,
      AbortSignal.timeout(5_000),
    )).toBe('pending')
    releaseRunning()
    expect(await submitting).toMatchObject({ ok: true, receipt: { state: 'started' } })
    expect(interventionRequestRecordSchema.parse(test.interventions.get(requested.interventionId)))
      .toMatchObject({ state: 'open' })
    expect(only(test.runs)).toMatchObject({
      state: 'waiting',
      blockingInterventionId: requested.interventionId,
    })
  })

  it('admits an initial Intervention after Assignment activation but before Intent completion', async () => {
    const test = harness()
    let releaseAssignment!: () => void
    let observeAssignment!: () => void
    const assignmentGate = new Promise<void>((resolve) => { releaseAssignment = resolve })
    const assignmentObserved = new Promise<void>((resolve) => { observeAssignment = resolve })
    test.assignments.afterNextUpdate = async () => {
      observeAssignment()
      await assignmentGate
    }

    const submitting = test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    await assignmentObserved
    const run = only(test.runs)
    expect(run).toMatchObject({ state: 'running' })
    expect(only(test.assignments)).toMatchObject({ state: 'active' })
    expect(only(test.intents)).toMatchObject({ phase: 'dispatching' })
    const requested = await test.operations.requestIntervention({
      sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_during_intent_completion'),
      prompt: 'Which path should this delivered Agent Run take?',
    }, AbortSignal.timeout(5_000))
    if (!requested.ok) throw new Error('test Intervention was not created')
    expect(await test.operations.finalizeInterventionOpening(
      requested.interventionId,
      AbortSignal.timeout(5_000),
    )).toBe('pending')

    releaseAssignment()
    expect(await submitting).toMatchObject({ ok: true, receipt: { state: 'started' } })
    expect(interventionRequestRecordSchema.parse(test.interventions.get(requested.interventionId)))
      .toMatchObject({ state: 'open' })
    expect(only(test.runs)).toMatchObject({
      state: 'waiting',
      blockingInterventionId: requested.interventionId,
    })
  })

  it('admits one successor Intervention while an accepted answer input is publishing', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_first_question')
    test.execution.beginNextOperation()
    let releaseStart!: () => void
    let observeStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    const startObserved = new Promise<void>((resolve) => { observeStart = resolve })
    test.execution.afterStart = async () => {
      observeStart()
      await startGate
    }
    const answering = test.operations.answerIntervention({
      type: 'answer-intervention',
      intentId: 'intent-62626262-6262-4262-8262-626262626262' as SakiControlIntentId,
      interventionId: open.id,
      expectedInterventionRevision: open.revision,
      answer: { kind: 'text', text: 'Continue, but ask for the remaining choice.' },
    }, actor(), AbortSignal.timeout(5_000))

    await startObserved
    const resumingRun = only(test.runs)
    expect(resumingRun).toMatchObject({
      state: 'resume-pending',
      blockingInterventionId: open.id,
    })
    const successor = await test.operations.requestIntervention({
      sessionId: resumingRun.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_successor_question'),
      prompt: 'Which remaining choice should I use?',
    }, AbortSignal.timeout(5_000))
    if (!successor.ok) throw new Error('successor Intervention was not created')
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
    const acceptedAnswerDispatch = [...test.dispatches.records.values()].at(-1)
    if (acceptedAnswerDispatch === undefined) throw new Error('answer Dispatch is absent')
    test.dispatches.records.set(
      acceptedAnswerDispatch.id,
      claimedDispatchForCorruption(acceptedAnswerDispatch, 'dispatch-claim-22222222-3333-4222-8222-222222222222'),
    )
    expect(() => test.operations.validateDurableState(new Set(), test.registry))
      .toThrow('opening Saki Intervention disagrees with its Agent Run')
    test.dispatches.records.set(acceptedAnswerDispatch.id, acceptedAnswerDispatch)
    expect(await test.operations.finalizeInterventionOpening(
      successor.interventionId,
      AbortSignal.timeout(5_000),
    )).toBe('pending')

    let releaseRunning!: () => void
    let observeRunning!: () => void
    const runningGate = new Promise<void>((resolve) => { releaseRunning = resolve })
    const runningObserved = new Promise<void>((resolve) => { observeRunning = resolve })
    test.runs.afterNextUpdate = async () => {
      observeRunning()
      await runningGate
    }
    releaseStart()
    await runningObserved
    expect(only(test.runs)).toMatchObject({ state: 'running' })
    expect(only(test.runs).blockingInterventionId).toBeUndefined()
    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state: 'answered' })
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
    expect(await test.operations.finalizeInterventionOpening(
      successor.interventionId,
      AbortSignal.timeout(5_000),
    )).toBe('pending')
    releaseRunning()
    expect(await answering).toMatchObject({ ok: true, receipt: { state: 'resolved' } })
    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state: 'resolved' })
    expect(interventionRequestRecordSchema.parse(test.interventions.get(successor.interventionId)))
      .toMatchObject({ state: 'open' })
    expect(only(test.runs)).toMatchObject({
      state: 'waiting',
      blockingInterventionId: successor.interventionId,
    })
  })

  it('admits one successor after answer delivery but before its predecessor resolves', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_answer_delivery_predecessor')
    test.execution.beginNextOperation()
    let releaseRunning!: () => void
    let observeRunning!: () => void
    const runningGate = new Promise<void>((resolve) => { releaseRunning = resolve })
    const runningObserved = new Promise<void>((resolve) => { observeRunning = resolve })
    test.execution.afterStart = () => {
      test.runs.afterNextUpdate = async () => {
        observeRunning()
        await runningGate
      }
    }
    const answering = test.operations.answerIntervention({
      type: 'answer-intervention',
      intentId: 'intent-63636363-6363-4363-8363-636363636363' as SakiControlIntentId,
      interventionId: open.id,
      expectedInterventionRevision: open.revision,
      answer: { kind: 'text', text: 'Continue into the next exact question.' },
    }, actor(), AbortSignal.timeout(5_000))

    await runningObserved
    const run = only(test.runs)
    expect(run).toMatchObject({ state: 'running' })
    expect(run.blockingInterventionId).toBeUndefined()
    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state: 'answered' })
    const successor = await test.operations.requestIntervention({
      sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_after_answer_delivery'),
      prompt: 'Which exact follow-up should I use?',
    }, AbortSignal.timeout(5_000))
    if (!successor.ok) throw new Error('successor Intervention was not created')
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
    expect(await test.operations.finalizeInterventionOpening(
      successor.interventionId,
      AbortSignal.timeout(5_000),
    )).toBe('pending')

    releaseRunning()
    expect(await answering).toMatchObject({ ok: true, receipt: { state: 'resolved' } })
    expect(interventionRequestRecordSchema.parse(test.interventions.get(successor.interventionId)))
      .toMatchObject({ state: 'open' })
    expect(only(test.runs)).toMatchObject({
      state: 'waiting',
      blockingInterventionId: successor.interventionId,
    })
  })

  it('serializes concurrent Intervention requests by Agent Run', async () => {
    const test = harness()
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const run = only(test.runs)
    const results = await Promise.all([
      test.operations.requestIntervention({
        sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
        toolCallId: CallId('call_concurrent_a'),
        prompt: 'Should this Run take path A?',
      }, AbortSignal.timeout(5_000)),
      test.operations.requestIntervention({
        sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
        toolCallId: CallId('call_concurrent_b'),
        prompt: 'Should this Run take path B?',
      }, AbortSignal.timeout(5_000)),
    ])

    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, reason: 'conflict' }])
    expect(test.interventions.size).toBe(1)
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
  })

  it('reconciles an initial-publication opening before its Run leaves the valid prefix', async () => {
    const test = harness()
    test.execution.startMode = 'reconciliation'
    let requested: { readonly ok: true; readonly interventionId: SakiInterventionRequestId } | undefined
    test.execution.afterStart = async () => {
      const run = only(test.runs)
      const result = await test.operations.requestIntervention({
        sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
        toolCallId: CallId('call_initial_reconciliation'),
        prompt: 'Can this ambiguous initial delivery continue?',
      }, AbortSignal.timeout(5_000))
      if (!result.ok) throw new Error('test Intervention was not created')
      requested = result
      test.interventions.simulateCrashAfterUpdateWhen(
        intervention => intervention.state === 'reconciliation-required',
      )
    }

    await expect(test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow(SimulatedProcessCrash)
    if (requested === undefined) throw new Error('test Intervention identity was not retained')
    test.restart()

    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
    expect(interventionRequestRecordSchema.parse(test.interventions.get(requested.interventionId)))
      .toMatchObject({ state: 'reconciliation-required', reason: 'effect-unknown' })
    expect(only(test.runs)).toMatchObject({ state: 'starting' })
  })

  it('reconciles a successor opening before an ambiguous answer changes its Run', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_answer_reconciliation_predecessor')
    test.execution.beginNextOperation()
    test.execution.startMode = 'reconciliation'
    let successor: { readonly ok: true; readonly interventionId: SakiInterventionRequestId } | undefined
    test.execution.afterStart = async () => {
      const run = only(test.runs)
      const result = await test.operations.requestIntervention({
        sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
        toolCallId: CallId('call_answer_reconciliation_successor'),
        prompt: 'Can this ambiguous answer delivery continue?',
      }, AbortSignal.timeout(5_000))
      if (!result.ok) throw new Error('successor Intervention was not created')
      successor = result
      test.interventions.simulateCrashAfterUpdateWhen(
        intervention => intervention.id === result.interventionId
          && intervention.state === 'reconciliation-required',
      )
    }
    const answer = interventionAnswer(
      open,
      'intent-64646464-6464-4464-8464-646464646464',
      'Attempt the exact answer delivery.',
    )

    await expect(test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow(SimulatedProcessCrash)
    if (successor === undefined) throw new Error('successor Intervention identity was not retained')
    test.restart()

    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state: 'answered' })
    expect(interventionRequestRecordSchema.parse(test.interventions.get(successor.interventionId)))
      .toMatchObject({ state: 'reconciliation-required', reason: 'effect-unknown' })
    expect(only(test.runs)).toMatchObject({ state: 'resume-pending' })
  })

  it('recovers after answer reconciliation reaches the Run before its Intervention', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_answer_reconciliation_crash')
    test.execution.beginNextOperation()
    test.execution.startMode = 'reconciliation'
    test.runs.simulateCrashAfterUpdateWhen(run => run.state === 'reconciliation-required')
    const answer = interventionAnswer(
      open,
      'intent-67676767-6767-4767-8767-676767676767',
      'Record this ambiguous delivery durably.',
    )

    await expect(test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow(SimulatedProcessCrash)
    expect(interventionRequestRecordSchema.parse(test.interventions.records.get(open.id)))
      .toMatchObject({ state: 'answered' })
    expect([...test.dispatches.records.values()].at(-1))
      .toMatchObject({ state: 'reconciliation-required', terminalReason: 'effect-unknown' })
    expect(only(test.runs)).toMatchObject({
      state: 'reconciliation-required',
      blockingInterventionId: open.id,
    })
    test.restart()

    const state = test.operations.validateDurableState(new Set(), test.registry)
    expect(state.answerPendingInterventionIds).toEqual([open.id])
    await test.operations.initializeValidated(state)

    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id))).toMatchObject({
      state: 'reconciliation-required',
      reason: 'effect-unknown',
    })
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
  })

  it('recovers an answered predecessor before finalizing its successor opening', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_restart_predecessor')
    test.execution.beginNextOperation()
    let successor: { readonly ok: true; readonly interventionId: SakiInterventionRequestId } | undefined
    test.execution.afterStart = async () => {
      const run = only(test.runs)
      const result = await test.operations.requestIntervention({
        sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
        toolCallId: CallId('call_restart_successor'),
        prompt: 'Which follow-up survives this restart?',
      }, AbortSignal.timeout(5_000))
      if (!result.ok) throw new Error('successor Intervention was not created')
      successor = result
      throw new SimulatedProcessCrash('process stopped after answer input execution began')
    }
    const answer = interventionAnswer(
      open,
      'intent-65656565-6565-4565-8565-656565656565',
      'Deliver this answer before recovering its successor.',
    )

    await expect(test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow(SimulatedProcessCrash)
    if (successor === undefined) throw new Error('successor Intervention identity was not retained')
    test.restart()
    const state = test.operations.validateDurableState(new Set(), test.registry)
    expect(state.answerPendingInterventionIds).toEqual([open.id])
    expect(state.openingInterventionIds).toEqual([successor.interventionId])

    await test.operations.initializeValidated(state)

    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state: 'resolved' })
    expect(interventionRequestRecordSchema.parse(test.interventions.get(successor.interventionId)))
      .toMatchObject({ state: 'open' })
    expect(only(test.runs)).toMatchObject({
      state: 'waiting',
      blockingInterventionId: successor.interventionId,
    })
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
  })

  it('returns deterministic Intervention restart work without inventing an Inbox queue', async () => {
    const test = harness()
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const run = only(test.runs)
    const requested = await test.operations.requestIntervention({
      sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_restart_inventory'),
      prompt: 'Which path survives restart?',
    }, AbortSignal.timeout(5_000))
    if (!requested.ok) throw new Error('test Intervention was not created')

    expect(test.operations.validateDurableState(new Set(), test.registry)).toMatchObject({
      openingInterventionIds: [requested.interventionId],
      answerPendingInterventionIds: [],
    })
    await test.operations.finalizeInterventionOpening(requested.interventionId, AbortSignal.timeout(5_000))
    const open = interventionRequestRecordSchema.parse(test.interventions.get(requested.interventionId))
    if (open.state !== 'open') throw new Error('test Intervention did not open')
    test.execution.beginNextOperation()
    test.execution.prepareMode = 'unavailable'
    const answerIntentId = 'intent-92929292-9292-4292-8292-929292929292' as SakiControlIntentId
    expect(await test.operations.answerIntervention({
      type: 'answer-intervention',
      intentId: answerIntentId,
      interventionId: open.id,
      expectedInterventionRevision: open.revision,
      answer: { kind: 'text', text: 'Use the retained path.' },
    }, actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'answered' },
    })

    const pending = test.operations.validateDurableState(new Set(), test.registry)
    expect(pending.openingInterventionIds).toEqual([])
    expect(pending.answerPendingInterventionIds).toEqual([requested.interventionId])
    expect(() => test.operations.validateDurableState(new Set([answerIntentId]), test.registry))
      .toThrow(`Saki Control Intent '${answerIntentId}' is retained by multiple Intent kinds`)

    const answered = interventionRequestRecordSchema.parse(test.interventions.get(requested.interventionId))
    if (answered.state !== 'answered') throw new Error('test Intervention did not retain its answer')
    test.dispatches.records.delete(answered.answer.dispatchId)
    expect(test.operations.validateDurableState(new Set(), test.registry).answerPendingInterventionIds)
      .toEqual([requested.interventionId])
    test.dispatches.records.delete(only(test.runs).dispatchIds[0]!)
    expect(() => test.operations.validateDurableState(new Set(), test.registry))
      .toThrow('lacks a preallocated child')
  })

  it('keeps Agent-requested Intervention identity stable and never settles a pending opening by timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const test = harness()
    expect(await test.operations.requestIntervention({
      sessionId: 'session-11111111-1111-4111-8111-111111111111' as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_unknown'),
      prompt: 'This Run does not exist.',
    }, AbortSignal.timeout(5_000))).toEqual({ ok: false, reason: 'unavailable' })

    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const run = only(test.runs)
    const request = {
      sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_stable_opening'),
      prompt: 'Should this wait for operator evidence?',
    }
    expect(await test.operations.requestIntervention({
      ...request,
      toolCallId: CallId('call_oversized'),
      prompt: 'p'.repeat(MAX_INTERVENTION_PROMPT_CHARS + 1),
    }, AbortSignal.timeout(5_000))).toEqual({ ok: false, reason: 'conflict' })
    expect(await test.operations.requestIntervention({
      ...request,
      toolCallId: CallId('call_unsafe_display'),
      prompt: 'Unsafe\u007fquestion',
    }, AbortSignal.timeout(5_000))).toEqual({ ok: false, reason: 'conflict' })
    const first = await test.operations.requestIntervention(request, AbortSignal.timeout(5_000))
    if (!first.ok) throw new Error('test Intervention was not created')
    expect(await test.operations.requestIntervention(request, AbortSignal.timeout(5_000))).toEqual(first)
    expect(await test.operations.requestIntervention({
      ...request,
      prompt: 'A changed question cannot reuse the same Tool Call.',
    }, AbortSignal.timeout(5_000))).toEqual({ ok: false, reason: 'conflict' })
    expect(await test.operations.requestIntervention({
      ...request,
      toolCallId: CallId('call_second_active'),
    }, AbortSignal.timeout(5_000))).toEqual({ ok: false, reason: 'conflict' })

    test.execution.interventionOpeningEvidence = { kind: 'pending' }
    expect(await test.operations.finalizeInterventionOpening(
      first.interventionId,
      AbortSignal.timeout(5_000),
    )).toBe('pending')
    vi.advanceTimersByTime(60_000)
    const initialDispatch = [...test.dispatches.records.values()][0]!
    test.operations.hostChanged({
      operation: {
        id: 'host-operation-12121212-1212-4212-8212-121212121212' as HostOperationId,
        hostId: initialDispatch.hostId,
        type: 'start-agent-run',
      },
      revision: 9,
    })
    await test.operations.dispose()

    expect(interventionRequestRecordSchema.parse(test.interventions.get(first.interventionId)))
      .toMatchObject({ state: 'opening', revision: 0 })
    expect(only(test.runs)).toMatchObject({ state: 'running' })
    vi.useRealTimers()
  })

  it('reuses a Tool Call identity only while its exact Intervention is opening', async () => {
    const resolved = harness()
    const resolvedRecord = await createResolvedIntervention(resolved, 'call_reused_after_resolution')
    const resolvedRun = only(resolved.runs)
    expect(await resolved.operations.requestIntervention({
      sessionId: resolvedRun.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: resolvedRecord.cause.toolCallId,
      prompt: resolvedRecord.requiredAnswer.prompt,
    }, AbortSignal.timeout(5_000))).toEqual({ ok: false, reason: 'conflict' })

    const reconciled = harness()
    const { open } = await createOpenIntervention(reconciled, 'call_reused_after_reconciliation', false)
    reconciled.execution.interventionOpeningEvidence = { kind: 'conflict' }
    expect(await reconciled.operations.finalizeInterventionOpening(
      open.id,
      AbortSignal.timeout(5_000),
      'startup',
    )).toBe('reconciliation-required')
    const reconciledRun = only(reconciled.runs)
    expect(await reconciled.operations.requestIntervention({
      sessionId: reconciledRun.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: open.cause.toolCallId,
      prompt: open.requiredAnswer.prompt,
    }, AbortSignal.timeout(5_000))).toEqual({ ok: false, reason: 'conflict' })
  })

  it('rejects an Intervention that could not reserve one later answer Dispatch', async () => {
    const test = harness()
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    for (let index = 1; index < 32; index += 1) {
      const run = only(test.runs)
      const requested = await test.operations.requestIntervention({
        sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
        toolCallId: CallId(`call_capacity_${index}`),
        prompt: `Choose exact capacity path ${index}.`,
      }, AbortSignal.timeout(5_000))
      if (!requested.ok) throw new Error('capacity Intervention was not created')
      expect(await test.operations.finalizeInterventionOpening(
        requested.interventionId,
        AbortSignal.timeout(5_000),
      )).toBe('open')
      const open = interventionRequestRecordSchema.parse(test.interventions.get(requested.interventionId))
      if (open.state !== 'open') throw new Error('capacity Intervention did not open')
      test.execution.beginNextOperation()
      expect(await test.operations.answerIntervention(
        interventionAnswer(
          open,
          `intent-aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`,
          `Use capacity path ${index}.`,
        ),
        actor(),
        AbortSignal.timeout(5_000),
      )).toMatchObject({ ok: true, receipt: { state: 'resolved' } })
    }
    const fullRun = only(test.runs)
    expect(fullRun.dispatchIds).toHaveLength(32)
    const retainedCount = test.interventions.size

    expect(await test.operations.requestIntervention({
      sessionId: fullRun.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_capacity_overflow'),
      prompt: 'This answer would require a thirty-third Dispatch.',
    }, AbortSignal.timeout(5_000))).toEqual({ ok: false, reason: 'conflict' })
    expect(test.interventions.size).toBe(retainedCount)

    test.restart()
    const recovered = test.operations.validateDurableState(new Set(), test.registry)
    expect(recovered.openingInterventionIds).toEqual([])
    expect(recovered.answerPendingInterventionIds).toEqual([])
    await test.operations.initializeValidated(recovered)
  })

  it('recovers the opening write split without allocating another Intervention', async () => {
    const test = harness()
    const { open, requested } = await createOpenIntervention(test, 'call_opening_crash', false)
    expect(open.state).toBe('opening')
    test.runs.simulateCrashAfterUpdateWhen(run => run.state === 'waiting')

    await expect(test.operations.finalizeInterventionOpening(
      requested.interventionId,
      AbortSignal.timeout(5_000),
    )).rejects.toThrow(SimulatedProcessCrash)
    test.restart()
    const restartState = test.operations.validateDurableState(new Set(), test.registry)
    expect(restartState.openingInterventionIds).toEqual([requested.interventionId])

    await test.operations.initializeValidated(restartState)

    expect(interventionRequestRecordSchema.parse(test.interventions.get(requested.interventionId)))
      .toMatchObject({ state: 'open', revision: 1 })
    expect(only(test.runs)).toMatchObject({
      state: 'waiting',
      blockingInterventionId: requested.interventionId,
    })
    expect(test.interventions.size).toBe(1)
  })

  it('rejects new requests while the Run waits and rejects an unavailable Assignment before persistence', async () => {
    const waiting = harness()
    const { open } = await createOpenIntervention(waiting, 'call_waiting_request')
    const run = only(waiting.runs)
    expect(await waiting.operations.requestIntervention({
      sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_while_waiting'),
      prompt: 'Can another request bypass the blocker?',
    }, AbortSignal.timeout(5_000))).toEqual({ ok: false, reason: 'conflict' })
    expect(await waiting.operations.finalizeInterventionOpening(open.id, AbortSignal.timeout(5_000))).toBe('open')

    const unavailable = harness()
    await unavailable.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const assignment = only(unavailable.assignments)
    unavailable.assignments.records.set(assignment.id, workAssignmentRecordSchema.parse({
      ...assignment,
      state: 'canceled',
    }))
    const unavailableRun = only(unavailable.runs)
    expect(await unavailable.operations.requestIntervention({
      sessionId: unavailableRun.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_unavailable_assignment'),
      prompt: 'This request has no active Assignment.',
    }, AbortSignal.timeout(5_000))).toEqual({ ok: false, reason: 'unavailable' })
    expect(unavailable.interventions.size).toBe(0)
  })

  it('reconciles confirmed opening evidence that cannot attach to the retained Run prefix', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_bad_run_prefix', false)
    const run = only(test.runs)
    test.runs.records.set(run.id, agentRunRecordSchema.parse({
      ...run,
      state: 'waiting',
      blockingInterventionId: 'intervention-25252525-2525-4525-8525-252525252525',
    }))

    expect(await test.operations.finalizeInterventionOpening(open.id, AbortSignal.timeout(5_000)))
      .toBe('reconciliation-required')
    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state: 'reconciliation-required', reason: 'protocol' })
  })

  it.each([
    ['absent', { kind: 'absent' }],
    ['pending', { kind: 'pending' }],
    ['conflicting', { kind: 'conflict', reason: 'tool-result-mismatch' }],
  ] as const)('classifies an abandoned %s opening from retained Host evidence', async (_kind, evidence) => {
    const test = harness()
    const { requested } = await createOpenIntervention(test, `call_startup_${_kind}`, false)
    test.execution.interventionOpeningEvidence = evidence
    test.restart()
    const state = test.operations.validateDurableState(new Set(), test.registry)

    await test.operations.initializeValidated(state)

    expect(interventionRequestRecordSchema.parse(test.interventions.get(requested.interventionId)))
      .toMatchObject({
        state: 'reconciliation-required',
        reason: _kind === 'conflicting' ? 'evidence-conflict' : _kind === 'pending' ? 'effect-unknown' : 'protocol',
      })
    expect(only(test.runs)).toMatchObject({ state: 'running' })
  })

  it('does not overwrite an opening that another serialized recovery already reconciled', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_serialized_opening_recovery', false)
    let releaseInspection!: () => void
    let observeInspection!: () => void
    const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve })
    const inspectionObserved = new Promise<void>((resolve) => { observeInspection = resolve })
    test.execution.inspectInterventionOpening = async () => {
      observeInspection()
      await inspectionGate
      return { kind: 'confirmed', turn: 1, step: 1 }
    }
    const finalizing = test.operations.finalizeInterventionOpening(open.id, AbortSignal.timeout(5_000))
    await inspectionObserved

    const retainedIntent = only(test.intents)
    test.intents.records.set(retainedIntent.id, agentOperationIntentRecordSchema.parse({
      ...retainedIntent,
      phase: 'dispatching',
    }))
    test.execution.inspectMode = 'reconciliation'
    let observeOpeningScan!: () => void
    const openingScanObserved = new Promise<void>((resolve) => { observeOpeningScan = resolve })
    const entries = test.interventions.entries.bind(test.interventions)
    test.interventions.entries = () => {
      observeOpeningScan()
      return entries()
    }
    const reconciling = test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    await openingScanObserved

    const reconciledAt = Math.max(open.updatedAt, Date.now())
    test.interventions.records.set(open.id, interventionRequestRecordSchema.parse({
      ...open,
      revision: open.revision + 1,
      state: 'reconciliation-required',
      openedAt: reconciledAt,
      reason: 'protocol',
      reconciliationRequiredAt: reconciledAt,
      updatedAt: reconciledAt,
    }))
    releaseInspection()

    expect(await finalizing).toBe('pending')
    expect(await reconciling).toMatchObject({ ok: false, reason: 'reconciliation-required' })
    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state: 'reconciliation-required', reason: 'protocol', revision: open.revision + 1 })
  })

  it('rejects stale, invalid, and unauthorized answers without changing the open winner slot', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_answer_boundaries')
    const stale = interventionAnswer(open, 'intent-13131313-1313-4313-8313-131313131313', 'stale')
    expect(await test.operations.answerIntervention({
      ...stale,
      expectedInterventionRevision: open.revision + 1,
    }, actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'expected-revision' },
    })

    test.interventions.records.set(open.id, interventionRequestRecordSchema.parse({
      ...open,
      requiredAnswer: { ...open.requiredAnswer, maxLength: 3 },
    }))
    expect(await test.operations.answerIntervention(
      interventionAnswer(open, 'intent-14141414-1414-4414-8414-141414141414', 'four'),
      actor(),
      AbortSignal.timeout(5_000),
    )).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'invalid-answer' },
    })
    expect(await test.operations.answerIntervention(
      interventionAnswer(open, 'intent-15151515-1515-4515-8515-151515151515', 'yes'),
      { ...actor(), principalId: 'principal-16161616-1616-4616-8616-161616161616' as SakiPrincipalId },
      AbortSignal.timeout(5_000),
    )).toEqual({ ok: false, reason: 'denied' })
    test.authorityCurrent = false
    expect(await test.operations.answerIntervention(
      interventionAnswer(open, 'intent-17171717-1717-4717-8717-171717171717', 'yes'),
      actor(),
      AbortSignal.timeout(5_000),
    )).toEqual({ ok: false, reason: 'denied' })

    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state: 'open', revision: open.revision })
    expect(test.dispatches.size).toBe(1)
  })

  it('retains one competing answer winner, its return facts, and an idempotent receipt', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_competing_answers')
    const returnAddress = open.returnAddress
    test.execution.beginNextOperation()
    const first = interventionAnswer(
      open,
      'intent-18181818-1818-4818-8818-181818181818',
      'Use the first durable answer.',
    )
    const second = interventionAnswer(
      open,
      'intent-19191919-1919-4919-8919-191919191919',
      'Use the competing answer.',
    )

    const [winner, loser] = await Promise.all([
      test.operations.answerIntervention(first, actor(), AbortSignal.timeout(5_000)),
      test.operations.answerIntervention(second, actor(), AbortSignal.timeout(5_000)),
    ])

    expect(winner).toMatchObject({ ok: true, receipt: { state: 'resolved', intentId: first.intentId } })
    expect(loser).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'already-answered' },
    })
    const resolved = interventionRequestRecordSchema.parse(test.interventions.get(open.id))
    expect(resolved).toMatchObject({
      state: 'resolved',
      returnAddress,
      answer: { payload: { intent: first, actor: actor() } },
    })
    expect(await test.operations.answerIntervention(first, actor(), AbortSignal.timeout(5_000))).toEqual(winner)
    expect(test.dispatches.size).toBe(2)
    expect(test.execution.startCount).toBe(2)
  })

  it.each(['same answer', 'competing answer'] as const)(
    'adopts one concurrently committed %s after losing the request revision CAS',
    async (winnerKind) => {
      const toolCallId = `call_concurrent_${winnerKind.replace(' ', '_')}`
      const winningIntentId = winnerKind === 'same answer'
        ? 'intent-56565656-5656-4656-8656-565656565656'
        : 'intent-57575757-5757-4757-8757-575757575757'
      const submittedIntentId = 'intent-56565656-5656-4656-8656-565656565656'
      const donor = harness()
      const { open: donorOpen } = await createOpenIntervention(donor, toolCallId)
      donor.execution.beginNextOperation()
      donor.execution.prepareMode = 'unavailable'
      await donor.operations.answerIntervention(
        interventionAnswer(donorOpen, winningIntentId, winnerKind),
        actor(),
        AbortSignal.timeout(5_000),
      )
      const committed = interventionRequestRecordSchema.parse(donor.interventions.get(donorOpen.id))
      if (committed.state !== 'answered') throw new Error('concurrent answer fixture was not accepted')
      const laterCommitted = interventionRequestRecordSchema.parse({
        ...committed,
        answer: { ...committed.answer, acceptedAt: committed.answer.acceptedAt + 60_000 },
        updatedAt: committed.updatedAt + 60_000,
      })

      const test = harness()
      const { open } = await createOpenIntervention(test, toolCallId)
      test.execution.beginNextOperation()
      test.interventions.beforeNextUpdate = () => {
        test.interventions.records.set(open.id, laterCommitted)
      }
      const result = await test.operations.answerIntervention(
        interventionAnswer(open, submittedIntentId, 'same answer'),
        actor(),
        AbortSignal.timeout(5_000),
      )

      expect(result).toMatchObject(winnerKind === 'same answer'
        ? { ok: true, receipt: { state: 'resolved', intentId: submittedIntentId } }
        : { ok: false, reason: 'conflict', receipt: { state: 'conflict', reason: 'already-answered' } })
    },
  )

  it('uses Host change notification to finish an accepted answer without a second answer Intent', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_host_change')
    const answer = interventionAnswer(
      open,
      'intent-21212121-2121-4121-8121-212121212121',
      'Continue when the retained Host operation changes.',
    )
    test.execution.beginNextOperation()
    test.execution.startMode = 'unavailable'
    expect(await test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'answered' } })
    const answerDispatch = [...test.dispatches.records.values()].at(-1)!
    if (answerDispatch.preparation === undefined) throw new Error('test answer Dispatch lacks Host preparation')
    test.execution.startMode = 'success'

    test.operations.hostChanged({
      operation: answerDispatch.preparation.operation,
      revision: (answerDispatch.operationSnapshot?.revision ?? 0) + 1,
    })
    await test.operations.dispose()

    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state: 'resolved', answer: { payload: { intent: answer } } })
    expect(only(test.runs)).toMatchObject({ state: 'running' })
    expect(test.dispatches.size).toBe(2)
  })

  it.each(['authority', 'Binding'] as const)(
    'rechecks answer %s after Host preparation before accepting its Dispatch',
    async (revoked) => {
      const test = harness()
      const { open } = await createOpenIntervention(test, `call_answer_prepare_${revoked}`)
      const initialStartCount = test.execution.startCount
      test.execution.beginNextOperation()
      test.execution.afterPrepare = () => {
        if (revoked === 'authority') test.authorityCurrent = false
        else test.bindingCurrent = false
      }

      expect(await test.operations.answerIntervention(
        interventionAnswer(open, 'intent-48484848-4848-4848-8848-484848484848', 'Keep the answer without delivering it.'),
        actor(),
        AbortSignal.timeout(5_000),
      )).toMatchObject({
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'protocol' },
      })
      expect(test.execution.startCount).toBe(initialStartCount)
      expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id))).toMatchObject({
        state: 'reconciliation-required',
        answer: { payload: { actor: actor() } },
      })
      expect(only(test.runs)).toMatchObject({ state: 'reconciliation-required' })
      expect([...test.dispatches.records.values()].at(-1)).toMatchObject({
        state: 'reconciliation-required',
        operationSnapshot: { state: 'prepared', admission: { kind: 'not-accepted' } },
        terminalReason: 'protocol',
      })
    },
  )

  it.each([
    ['deleted after preparation', (test: Harness) => {
      test.execution.afterPrepare = () => {
        const dispatch = [...test.dispatches.records.values()].at(-1)
        if (dispatch === undefined) throw new Error('answer Dispatch is absent')
        test.dispatches.records.delete(dispatch.id)
      }
    }, 'unavailable'],
    ['claimed by another executor after preparation', (test: Harness) => {
      test.execution.afterPrepare = () => {
        const dispatch = [...test.dispatches.records.values()].at(-1)
        if (dispatch?.state !== 'claimed') throw new Error('answer Dispatch is not claimed')
        test.dispatches.records.set(dispatch.id, executionDispatchRecordSchema.parse({
          ...dispatch,
          claim: {
            ...dispatch.claim,
            id: 'dispatch-claim-60606060-6060-4060-8060-606060606060',
          },
        }))
      }
    }, 'unavailable'],
    ['revision-changed before preparation persistence', (test: Harness) => {
      test.execution.afterPrepare = () => {
        test.dispatches.beforeNextUpdate = () => {
          const dispatch = [...test.dispatches.records.values()].at(-1)
          if (dispatch === undefined) throw new Error('answer Dispatch is absent')
          test.dispatches.records.set(dispatch.id, executionDispatchRecordSchema.parse({
            ...dispatch,
            revision: dispatch.revision + 1,
          }))
        }
      }
    }, 'unavailable'],
    ['rejected by storage before preparation persistence', (test: Harness) => {
      test.execution.afterPrepare = () => {
        test.dispatches.beforeNextUpdate = () => { throw new Error('injected preparation storage failure') }
      }
    }, 'throws'],
    ['expired while preparation persistence completed', (test: Harness) => {
      test.execution.afterPrepare = () => {
        test.dispatches.beforeNextUpdate = () => {
          const dispatch = [...test.dispatches.records.values()].at(-1)
          if (dispatch?.state !== 'claimed') throw new Error('answer Dispatch is not claimed')
          const now = Date.now()
          test.dispatches.records.set(dispatch.id, executionDispatchRecordSchema.parse({
            ...dispatch,
            claim: { ...dispatch.claim, issuedAt: now - 1, expiresAt: now + 1 },
          }))
        }
        test.dispatches.afterNextUpdate = async () => {
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      }
    }, 'unavailable'],
    ['lost atomically during acceptance', (test: Harness) => {
      test.execution.afterPrepare = () => {
        test.dispatches.afterNextUpdate = () => {
          test.dispatches.beforeNextUpdate = () => { test.authorityCurrent = false }
        }
      }
    }, 'unavailable'],
    ['committed before its storage acknowledgement was lost', (test: Harness) => {
      test.execution.afterPrepare = () => {
        test.dispatches.afterNextUpdate = () => {
          test.dispatches.afterNextUpdate = () => { throw new Error('injected acceptance acknowledgement loss') }
        }
      }
    }, 'resolved'],
    ['rejected by storage before acceptance', (test: Harness) => {
      test.execution.afterPrepare = () => {
        test.dispatches.afterNextUpdate = () => {
          test.dispatches.beforeNextUpdate = () => { throw new Error('injected acceptance storage failure') }
        }
      }
    }, 'throws'],
    ['deleted by storage before acceptance failure recovery', (test: Harness) => {
      test.execution.afterPrepare = () => {
        test.dispatches.afterNextUpdate = () => {
          test.dispatches.beforeNextUpdate = () => {
            const dispatch = [...test.dispatches.records.values()].at(-1)
            if (dispatch === undefined) throw new Error('answer Dispatch is absent')
            test.dispatches.records.delete(dispatch.id)
            throw new Error('injected acceptance deletion')
          }
        }
      }
    }, 'throws'],
  ] as const)(
    'handles an answer Dispatch %s',
    async (_description, arrange, outcome) => {
      const test = harness()
      const { open } = await createOpenIntervention(test, `call_claim_race_${outcome}_${_description}`)
      const answer = interventionAnswer(
        open,
        'intent-61616161-6161-4161-8161-616161616161',
        'Retain the answer across this Dispatch claim race.',
      )
      test.execution.beginNextOperation()
      arrange(test)

      const attempt = test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000))
      if (outcome === 'throws') {
        await expect(attempt).rejects.toThrow('injected')
      } else {
        expect(await attempt).toMatchObject(outcome === 'resolved'
          ? { ok: true, receipt: { state: 'resolved' } }
          : { ok: false, reason: 'unavailable', receipt: { state: 'answered' } })
      }
    },
  )

  it('leaves an accepted answer pending while another executor owns its Dispatch claim', async () => {
    const test = harness()
    const answered = await createAnsweredIntervention(test, 'call_foreign_answer_claim')
    const dispatch = test.dispatches.records.get(answered.answer.dispatchId)
    if (dispatch?.state !== 'claimed') throw new Error('answer Dispatch is not claimed')
    test.dispatches.records.set(dispatch.id, executionDispatchRecordSchema.parse({
      ...dispatch,
      claim: {
        ...dispatch.claim,
        executorHostId: 'host-70707070-7070-4070-8070-707070707070',
      },
    }))

    expect(await test.operations.answerIntervention(
      answered.answer.payload.intent,
      actor(),
      AbortSignal.timeout(5_000),
    )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'answered' } })
  })

  it.each(['authority', 'Binding', 'Host expectation'] as const)(
    'rechecks answer %s after Dispatch acceptance before Host admission',
    async (revoked) => {
      const test = harness()
      const { open } = await createOpenIntervention(test, `call_answer_admission_${revoked}`)
      const initialStartCount = test.execution.startCount
      test.execution.beginNextOperation()
      if (revoked === 'Host expectation') {
        test.execution.admissionExpectation = expectation => ({
          ...expectation,
          bindingRevision: expectation.bindingRevision + 1,
        })
      } else {
        test.execution.beforeAdmission = () => {
          if (revoked === 'authority') test.authorityCurrent = false
          else test.bindingCurrent = false
        }
      }

      expect(await test.operations.answerIntervention(
        interventionAnswer(open, 'intent-49494949-4949-4949-8949-494949494949', 'Keep the answer pending until authority returns.'),
        actor(),
        AbortSignal.timeout(5_000),
      )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'answered' } })
      expect(test.execution.startCount).toBe(initialStartCount + 1)
      expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
        .toMatchObject({ state: 'answered', answer: { payload: { actor: actor() } } })
      expect(only(test.runs)).toMatchObject({
        state: 'resume-pending',
        blockingInterventionId: open.id,
      })
      expect([...test.dispatches.records.values()].at(-1)).toMatchObject({
        state: 'accepted',
        operationSnapshot: { state: 'prepared', admission: { kind: 'not-accepted' } },
      })
    },
  )

  it.each([
    ['a conflicting Host preparation', 'prepare', 'source-conflict', 'protocol'],
    ['a terminal Host preparation', 'prepare', 'terminal-failed', 'protocol'],
    ['a reconciliation-required start', 'start', 'reconciliation', 'effect-unknown'],
    ['a failed start', 'start', 'failed', 'protocol'],
    ['a canceled start', 'start', 'canceled-source', 'protocol'],
    ['mismatched success evidence', 'start', 'mismatched-result', 'evidence-conflict'],
  ] as const)('reconciles an accepted answer after %s', async (_description, phase, mode, reason) => {
    const test = harness()
    const { open } = await createOpenIntervention(test, `call_${mode}`)
    const answer = interventionAnswer(
      open,
      'intent-22222222-2222-4222-8222-222222222222',
      'Retain this answer even when delivery needs reconciliation.',
    )
    test.execution.beginNextOperation()
    if (phase === 'prepare') test.execution.prepareMode = mode
    else test.execution.startMode = mode

    const reconciled = await test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000))
    expect(reconciled).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason },
    })
    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id))).toMatchObject({
      state: 'reconciliation-required',
      reason,
      returnAddress: open.returnAddress,
      answer: { payload: { intent: answer } },
    })
    expect(only(test.runs)).toMatchObject({ state: 'reconciliation-required' })
    expect([...test.dispatches.records.values()].at(-1)).toMatchObject({
      state: 'reconciliation-required',
      terminalReason: reason,
    })
    expect(await test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000)))
      .toEqual(reconciled)
  })

  it.each(['preparation', 'snapshot'] as const)(
    'rejects mismatched Host %s evidence before accepting an answer Dispatch',
    async (kind) => {
      const test = harness()
      const { open } = await createOpenIntervention(test, `call_mismatched_host_${kind}`)
      test.execution.beginNextOperation()
      test.execution.prepareResult = receipt => kind === 'preparation'
        ? {
          ...receipt,
          preparation: {
            ...receipt.preparation,
            operation: {
              ...receipt.preparation.operation,
              id: 'host-operation-71717171-7171-4171-8171-717171717171' as HostOperationId,
            },
          },
        }
        : {
          ...receipt,
          snapshot: { ...receipt.snapshot, bindingRevision: receipt.snapshot.bindingRevision + 1 },
        }

      await expect(test.operations.answerIntervention(
        interventionAnswer(
          open,
          'intent-71717171-7171-4171-8171-717171717171',
          'Reject mismatched Host evidence.',
        ),
        actor(),
        AbortSignal.timeout(5_000),
      )).rejects.toThrow(kind === 'preparation'
        ? 'Host preparation disagrees with its Saki Intervention answer Dispatch'
        : 'Host snapshot disagrees with its Saki Intervention answer Dispatch')
    },
  )

  it.each([
    ['an unavailable inspection', (test: Harness) => {
      test.eligibility.projectInspection = { ok: false, reason: 'unavailable' }
    }, 'answered', undefined],
    ['a thrown inspection', (test: Harness) => {
      test.execution.projectInspectionError = new Error('test inspection failed')
    }, 'answered', undefined],
    ['a stale Binding inspection', (test: Harness) => {
      test.eligibility.projectInspection = { ok: false, reason: 'binding-stale' }
    }, 'reconciliation-required', 'protocol'],
    ['an unavailable structured mutation', (test: Harness) => {
      updateProjectInspection(test, current => ({
        ...current,
        observation: {
          ...current.observation,
          structuredMutation: { available: false, blockers: ['unmerged'] },
        },
      }))
    }, 'answered', undefined],
  ] as const)('keeps the answer durable after %s', async (_description, arrange, state, reason) => {
    const test = harness()
    const { open } = await createOpenIntervention(test, `call_inspection_${state}_${_description}`)
    const answer = interventionAnswer(
      open,
      'intent-23232323-2323-4323-8323-232323232323',
      'Do not lose this accepted response.',
    )
    test.execution.beginNextOperation()
    arrange(test)

    const result = await test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000))

    expect(result).toMatchObject(state === 'answered'
      ? { ok: false, reason: 'unavailable', receipt: { state: 'answered' } }
      : { ok: false, reason: 'reconciliation-required', receipt: { state, reason } })
    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state, ...(reason === undefined ? {} : { reason }), answer: { payload: { intent: answer } } })
    expect(test.operations.validateDurableState(new Set(), test.registry).answerPendingInterventionIds)
      .toEqual(state === 'answered' ? [open.id] : [])
  })

  it.each([
    ['lost its Dispatch outside a resumable Run prefix', (test: Harness, answered: Extract<InterventionRequestRecord, { readonly state: 'answered' }>) => {
      test.dispatches.records.delete(answered.answer.dispatchId)
      const run = only(test.runs)
      test.runs.records.set(run.id, agentRunRecordSchema.parse({
        ...run,
        state: 'allocated',
        blockingInterventionId: undefined,
      }))
    }, 'protocol'],
    ['lost its Binding before recreating a missing Dispatch', (test: Harness, answered: Extract<InterventionRequestRecord, { readonly state: 'answered' }>) => {
      test.dispatches.records.delete(answered.answer.dispatchId)
      test.bindingCurrent = false
    }, 'protocol'],
    ['retained a mismatched input plan before recreating a missing Dispatch', (test: Harness, answered: Extract<InterventionRequestRecord, { readonly state: 'answered' }>) => {
      test.dispatches.records.delete(answered.answer.dispatchId)
      const inputPlan = { ...answered.answer.inputPlan, payloadDigest: 'f'.repeat(64) }
      test.interventions.records.set(answered.id, interventionRequestRecordSchema.parse({
        ...answered,
        answer: { ...answered.answer, inputPlan },
      }))
      const run = only(test.runs)
      test.runs.records.set(run.id, agentRunRecordSchema.parse({ ...run, inputPlan }))
    }, 'evidence-conflict'],
    ['retained a Dispatch for another answer Intent', (test: Harness, answered: Extract<InterventionRequestRecord, { readonly state: 'answered' }>) => {
      const dispatch = test.dispatches.records.get(answered.answer.dispatchId)
      if (dispatch === undefined) throw new Error('answer Dispatch is absent')
      test.dispatches.records.set(dispatch.id, executionDispatchRecordSchema.parse({
        ...dispatch,
        intentId: 'intent-62626262-6262-4262-8262-626262626262',
      }))
    }, 'evidence-conflict'],
    ['retained its Dispatch outside every resumable Run prefix', (test: Harness) => {
      const run = only(test.runs)
      test.runs.records.set(run.id, agentRunRecordSchema.parse({
        ...run,
        state: 'allocated',
        blockingInterventionId: undefined,
      }))
    }, 'protocol'],
  ] as const)(
    'reconciles an answer that %s',
    async (_description, arrange, reason) => {
      const test = harness()
      const answered = await createAnsweredIntervention(test, `call_materialization_${reason}_${_description}`)
      arrange(test, answered)

      expect(await test.operations.answerIntervention(
        answered.answer.payload.intent,
        actor(),
        AbortSignal.timeout(5_000),
      )).toMatchObject({
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason },
      })
    },
  )

  it.each([
    ['reconciliation-required inspection', 'reconciliation', 'success', 'reconciliation-required', 'effect-unknown'],
    ['failed inspection', 'failed', 'success', 'reconciliation-required', 'protocol'],
    ['canceled inspection', 'canceled-source', 'success', 'reconciliation-required', 'protocol'],
    ['unavailable replay preparation', 'current', 'unavailable', 'answered', undefined],
    ['conflicting replay preparation', 'current', 'source-conflict', 'reconciliation-required', 'protocol'],
  ] as const)(
    'recovers an accepted answer after %s',
    async (_description, inspectMode, prepareMode, state, reason) => {
      const test = harness()
      const { open } = await createOpenIntervention(test, `call_accepted_${inspectMode}_${prepareMode}`)
      const answer = interventionAnswer(
        open,
        'intent-58585858-5858-4858-8858-585858585858',
        'Resume this accepted answer from retained Host evidence.',
      )
      test.execution.beginNextOperation()
      test.execution.startMode = 'unavailable'
      expect(await test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000)))
        .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'answered' } })
      test.execution.inspectMode = inspectMode
      test.execution.prepareMode = prepareMode

      const recovered = await test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000))

      expect(recovered).toMatchObject(state === 'answered'
        ? { ok: false, reason: 'unavailable', receipt: { state } }
        : { ok: false, reason: 'reconciliation-required', receipt: { state, reason } })
    },
  )

  it.each(['canceled', 'reconciliation-required'] as const)(
    'reconciles a retained %s answer Dispatch before another Host attempt',
    async (state) => {
      const test = harness()
      const answered = await createAnsweredIntervention(test, `call_retained_${state}`)
      const dispatch = [...test.dispatches.records.values()].at(-1)
      if (dispatch === undefined) throw new Error('answer Dispatch is absent')
      test.dispatches.records.set(dispatch.id, executionDispatchRecordSchema.parse({
        ...dispatch,
        state,
        claim: undefined,
        terminalReason: state === 'canceled' ? 'authority-revoked' : 'protocol',
      }))

      expect(await test.operations.answerIntervention(
        answered.answer.payload.intent,
        actor(),
        AbortSignal.timeout(5_000),
      )).toMatchObject({
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'protocol' },
      })
    },
  )

  it('rejects an answer until the Agent request is confirmed open', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_not_open', false)
    const answer: AnswerInterventionIntent = {
      type: 'answer-intervention',
      intentId: 'intent-24242424-2424-4424-8424-242424242424' as SakiControlIntentId,
      interventionId: open.id,
      expectedInterventionRevision: open.revision,
      answer: { kind: 'text', text: 'Too early.' },
    }

    expect(await test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'owner-unavailable' },
      })
    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state: 'opening', revision: 0 })
  })

  it('fails closed when a durable Intervention owner relation disappears before use', async () => {
    const requesting = harness()
    await requesting.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const requestingRun = only(requesting.runs)
    requesting.admissions.records.delete(requestingRun.bindingId)
    expect(await requesting.operations.requestIntervention({
      sessionId: requestingRun.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
      toolCallId: CallId('call_missing_request_admission'),
      prompt: 'This request has lost its write admission.',
    }, AbortSignal.timeout(5_000))).toEqual({ ok: false, reason: 'unavailable' })

    const opening = harness()
    const { open: openingRecord } = await createOpenIntervention(opening, 'call_owner_drift', false)
    const openingAssignment = only(opening.assignments)
    opening.assignments.records.set(openingAssignment.id, workAssignmentRecordSchema.parse({
      ...openingAssignment,
      state: 'canceled',
    }))
    expect(await opening.operations.finalizeInterventionOpening(
      openingRecord.id,
      AbortSignal.timeout(5_000),
    )).toBe('reconciliation-required')

    const answering = harness()
    const { open } = await createOpenIntervention(answering, 'call_missing_answer_admission')
    answering.admissions.records.delete(only(answering.runs).bindingId)
    expect(await answering.operations.answerIntervention(
      interventionAnswer(open, 'intent-45454545-4545-4545-8545-454545454545', 'Do not deliver without an owner.'),
      actor(),
      AbortSignal.timeout(5_000),
    )).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'owner-unavailable' },
    })
  })

  it.each([
    ['after accepting the answer', (test: Harness) => {
      test.interventions.simulateCrashAfterUpdateWhen(intervention => intervention.state === 'answered')
    }],
    ['after recording the resume plan', (test: Harness) => {
      test.runs.simulateCrashAfterUpdateWhen(run => run.state === 'resume-pending')
    }],
    ['after recording successful delivery', (test: Harness) => {
      test.runs.simulateCrashAfterUpdateWhen(run => run.state === 'running' && run.dispatchIds.length === 2)
    }],
  ] as const)('recovers the same answer and Run when the process stops %s', async (_checkpoint, inject) => {
    const test = harness()
    const { open } = await createOpenIntervention(test, `call_${_checkpoint.replaceAll(' ', '_')}`)
    const answer = interventionAnswer(
      open,
      'intent-20202020-2020-4020-8020-202020202020',
      'Resume this exact Run.',
    )
    test.execution.beginNextOperation()
    inject(test)

    await expect(test.operations.answerIntervention(answer, actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow(SimulatedProcessCrash)
    test.restart()
    const restartState = test.operations.validateDurableState(new Set(), test.registry)
    expect(restartState.answerPendingInterventionIds).toEqual([open.id])

    await test.operations.initializeValidated(restartState)

    expect(interventionRequestRecordSchema.parse(test.interventions.get(open.id)))
      .toMatchObject({ state: 'resolved', answer: { payload: { intent: answer } } })
    expect(only(test.runs).state).toBe('running')
    expect(only(test.runs).dispatchIds).toEqual([...test.dispatches.records.keys()])
    expect(Object.hasOwn(only(test.runs), 'blockingInterventionId')).toBe(false)
    expect(test.dispatches.size).toBe(2)
    expect(test.operations.validateDurableState(new Set(), test.registry).answerPendingInterventionIds)
      .toEqual([])
  })

  it('persists the Agent-requested Intervention relation owned by its exact Agent Run', async () => {
    const test = harness()
    const { open } = await createOpenIntervention(test, 'call_relation_variants', false)
    const run = only(test.runs)
    expect(open).toMatchObject({
      owner: { kind: 'agent-run', agentRunId: run.id, workSessionId: run.workSessionId },
      subject: { kind: 'agent-run', agentRunId: run.id },
      blockingScope: { kind: 'agent-run', agentRunId: run.id },
      cause: { kind: 'agent-request', agentRunId: run.id, workSessionId: run.workSessionId },
      returnAddress: {
        kind: 'agent-run',
        projectId: run.projectId,
        workItemId: run.workItemId,
        workSessionId: run.workSessionId,
        agentRunId: run.id,
      },
    })
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
  })

  it.each([
    ['an unknown owner Run', (test: Harness, intervention: InterventionRequestRecord) => {
      const agentRunId = 'agent-run-26262626-2626-4626-8626-262626262626' as SakiAgentRunId
      test.interventions.records.set(intervention.id, interventionRequestRecordSchema.parse({
        ...intervention,
        owner: { ...intervention.owner, agentRunId },
        cause: { ...intervention.cause, agentRunId },
        subject: { ...intervention.subject, agentRunId },
        blockingScope: { ...intervention.blockingScope, agentRunId },
        returnAddress: { ...intervention.returnAddress, agentRunId },
      }))
    }, 'inconsistent ownership'],
    ['another Project', (test: Harness, intervention: InterventionRequestRecord) => {
      const projectId = 'project-27272727-2727-4727-8727-272727272727' as SakiDevelopmentProjectId
      test.interventions.records.set(intervention.id, interventionRequestRecordSchema.parse({
        ...intervention,
        projectId,
        returnAddress: { ...intervention.returnAddress, projectId },
      }))
    }, 'inconsistent ownership'],
    ['another Principal', (test: Harness, intervention: InterventionRequestRecord) => {
      test.interventions.records.set(intervention.id, interventionRequestRecordSchema.parse({
        ...intervention,
        targetPrincipalId: 'principal-28282828-2828-4828-8828-282828282828',
      }))
    }, 'inconsistent ownership'],
    ['another subject Run', (test: Harness, intervention: InterventionRequestRecord) => {
      test.interventions.records.set(intervention.id, interventionRequestRecordSchema.parse({
        ...intervention,
        subject: { kind: 'agent-run', agentRunId: 'agent-run-29292929-2929-4929-8929-292929292929' },
      }))
    }, 'inconsistent ownership'],
    ['another physical Session cause', (test: Harness, intervention: InterventionRequestRecord) => {
      test.interventions.records.set(intervention.id, interventionRequestRecordSchema.parse({
        ...intervention,
        cause: { ...intervention.cause, sessionId: 'session-34343434-3434-4434-8434-343434343434' },
      }))
    }, 'inconsistent ownership'],
    ['another blocking Run', (test: Harness, intervention: InterventionRequestRecord) => {
      test.interventions.records.set(intervention.id, interventionRequestRecordSchema.parse({
        ...intervention,
        blockingScope: {
          kind: 'agent-run',
          agentRunId: 'agent-run-29292929-2929-4929-8929-292929292929',
        },
      }))
    }, 'inconsistent ownership'],
    ['another return Work Item', (test: Harness, intervention: InterventionRequestRecord) => {
      test.interventions.records.set(intervention.id, interventionRequestRecordSchema.parse({
        ...intervention,
        returnAddress: { ...intervention.returnAddress, workItemId: `work-item-${'3'.repeat(64)}` },
      }))
    }, 'inconsistent ownership'],
  ] as const)('rejects an Intervention owned by %s', async (_description, corrupt, message) => {
    const test = harness()
    const { open } = await createOpenIntervention(test, `call_corrupt_${_description}`, false)
    corrupt(test, open)

    expect(() => test.operations.validateDurableState(new Set(), test.registry)).toThrow(message)
  })

  it('rejects impossible Intervention lifecycle and Dispatch graph combinations', async () => {
    const opening = harness()
    const { open: openingRecord } = await createOpenIntervention(opening, 'call_bad_opening_lifecycle', false)
    const openingRun = only(opening.runs)
    opening.runs.records.set(openingRun.id, agentRunRecordSchema.parse({
      ...openingRun,
      state: 'waiting',
      blockingInterventionId: 'intervention-31313131-3131-4131-8131-313131313131',
    }))
    expect(() => opening.operations.validateDurableState(new Set(), opening.registry))
      .toThrow('opening Saki Intervention disagrees with its Agent Run')

    const opened = harness()
    await createOpenIntervention(opened, 'call_bad_open_lifecycle')
    const openedRun = only(opened.runs)
    opened.runs.records.set(openedRun.id, agentRunRecordSchema.parse({
      ...openedRun,
      state: 'running',
      blockingInterventionId: undefined,
    }))
    expect(() => opened.operations.validateDurableState(new Set(), opened.registry))
      .toThrow('open Saki Intervention lacks its waiting Agent Run')

    const answered = harness()
    const answeredRecord = await createAnsweredIntervention(answered, 'call_bad_answered_lifecycle')
    const answeredRun = only(answered.runs)
    const initialResult = [...answered.dispatches.records.values()][0]?.operationSnapshot
    if (initialResult?.state !== 'succeeded') throw new Error('test initial Host result is absent')
    answered.runs.records.set(answeredRun.id, agentRunRecordSchema.parse({
      ...answeredRun,
      state: 'running',
      blockingInterventionId: undefined,
      hostResult: {
        ...initialResult.result,
        inputMessageId: answeredRecord.answer.inputPlan.messageId,
      },
    }))
    expect(() => answered.operations.validateDurableState(new Set(), answered.registry))
      .toThrow('answered Saki Intervention has an inconsistent Agent Run prefix')

    const resolved = harness()
    const resolvedRecord = await createResolvedIntervention(resolved, 'call_bad_resolved_lifecycle')
    const resolvedRun = only(resolved.runs)
    resolved.runs.records.set(resolvedRun.id, agentRunRecordSchema.parse({
      ...resolvedRun,
      state: 'waiting',
      blockingInterventionId: resolvedRecord.id,
    }))
    expect(() => resolved.operations.validateDurableState(new Set(), resolved.registry))
      .toThrow('resolved Saki Intervention still blocks its Agent Run')

    const missingDispatch = harness()
    const missingRecord = await createResolvedIntervention(missingDispatch, 'call_missing_answer_dispatch')
    missingDispatch.dispatches.records.delete(missingRecord.answer.dispatchId)
    expect(() => missingDispatch.operations.validateDurableState(new Set(), missingDispatch.registry))
      .toThrow('resolved Saki Intervention lacks its answer Dispatch')

    const mismatchedDispatch = harness()
    const mismatchedRecord = await createResolvedIntervention(mismatchedDispatch, 'call_mismatched_answer_dispatch')
    const answerDispatch = mismatchedDispatch.dispatches.records.get(mismatchedRecord.answer.dispatchId)!
    mismatchedDispatch.dispatches.records.set(answerDispatch.id, executionDispatchRecordSchema.parse({
      ...answerDispatch,
      intentId: 'intent-32323232-3232-4232-8232-323232323232',
    }))
    expect(() => mismatchedDispatch.operations.validateDurableState(new Set(), mismatchedDispatch.registry))
      .toThrow('Saki Intervention answer Dispatch disagrees with its owner')

    const historical = harness()
    const historicalRecord = await createResolvedIntervention(
      historical,
      'call_historical_answer_dispatch',
      'intent-35353535-3535-4535-8535-353535353535' as SakiControlIntentId,
    )
    await createResolvedIntervention(
      historical,
      'call_latest_answer_dispatch',
      'intent-36363636-3636-4636-8636-363636363636' as SakiControlIntentId,
    )
    const historicalDispatch = historical.dispatches.records.get(historicalRecord.answer.dispatchId)!
    historical.dispatches.records.set(historicalDispatch.id, executionDispatchRecordSchema.parse({
      ...historicalDispatch,
      state: 'reconciliation-required',
      terminalReason: 'protocol',
    }))
    expect(() => historical.operations.validateDurableState(new Set(), historical.registry))
      .toThrow('resolved Saki Intervention lacks exact succeeded answer Dispatch evidence')

    expect(openingRecord.state).toBe('opening')
    expect(answeredRecord.state).toBe('answered')
  })

  it('rejects independently valid corruption in the Intervention Dispatch graph', async () => {
    const duplicateAnswerDispatch = harness()
    const firstResolved = await createResolvedIntervention(
      duplicateAnswerDispatch,
      'call_duplicate_dispatch_first',
      'intent-63636363-6363-4363-8363-636363636363' as SakiControlIntentId,
    )
    const secondResolved = await createResolvedIntervention(
      duplicateAnswerDispatch,
      'call_duplicate_dispatch_second',
      'intent-64646464-6464-4464-8464-646464646464' as SakiControlIntentId,
    )
    duplicateAnswerDispatch.interventions.records.set(secondResolved.id, interventionRequestRecordSchema.parse({
      ...secondResolved,
      answer: { ...secondResolved.answer, dispatchId: firstResolved.answer.dispatchId },
    }))
    expect(() => duplicateAnswerDispatch.operations.validateDurableState(new Set(), duplicateAnswerDispatch.registry))
      .toThrow('is retained by multiple Interventions')

    const absentResolvedDispatch = harness()
    await createResolvedIntervention(absentResolvedDispatch, 'call_resolved_absent_from_run')
    const absentRun = only(absentResolvedDispatch.runs)
    absentResolvedDispatch.runs.records.set(absentRun.id, agentRunRecordSchema.parse({
      ...absentRun,
      dispatchIds: [absentRun.dispatchIds[0]],
    }))
    expect(() => absentResolvedDispatch.operations.validateDurableState(new Set(), absentResolvedDispatch.registry))
      .toThrow('resolved Saki Intervention answer is absent from its Agent Run')

    const multipleOpenings = harness()
    const { open: firstOpening } = await createOpenIntervention(multipleOpenings, 'call_multiple_openings', false)
    const secondOpeningId = 'intervention-65656565-6565-4565-8565-656565656565' as SakiInterventionRequestId
    multipleOpenings.interventions.records.set(secondOpeningId, interventionRequestRecordSchema.parse({
      ...firstOpening,
      id: secondOpeningId,
      cause: { ...firstOpening.cause, toolCallId: CallId('call_second_opening') },
    }))
    expect(() => multipleOpenings.operations.validateDurableState(new Set(), multipleOpenings.registry))
      .toThrow('multiple active Intervention Requests')

    const unattributedResume = harness()
    const unattributed = await createResolvedIntervention(unattributedResume, 'call_unattributed_resume')
    unattributedResume.interventions.records.delete(unattributed.id)
    expect(() => unattributedResume.operations.validateDurableState(new Set(), unattributedResume.registry))
      .toThrow('has an unattributed resume Dispatch')

    const invalidResumePending = harness()
    await invalidResumePending.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const pendingRun = only(invalidResumePending.runs)
    invalidResumePending.runs.records.set(pendingRun.id, agentRunRecordSchema.parse({
      ...pendingRun,
      state: 'resume-pending',
      hostResult: undefined,
      blockingInterventionId: 'intervention-69696969-6969-4969-8969-696969696969',
    }))
    expect(() => invalidResumePending.operations.validateDurableState(new Set(), invalidResumePending.registry))
      .toThrow('resume-pending Saki Agent Run lacks its answered Intervention')

    const invalidBlocker = harness()
    const { open: deletedBlocker } = await createOpenIntervention(invalidBlocker, 'call_deleted_blocker')
    invalidBlocker.interventions.records.delete(deletedBlocker.id)
    expect(() => invalidBlocker.operations.validateDurableState(new Set(), invalidBlocker.registry))
      .toThrow('has an invalid blocking Intervention')

    const orphanDispatch = harness()
    await orphanDispatch.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const originalDispatch = only(orphanDispatch.dispatches)
    const orphanDispatchId = 'dispatch-67676767-6767-4767-8767-676767676767' as SakiExecutionDispatchId
    const orphanInput = {
      ...originalDispatch.hostRequest.run.input,
      source: { ...originalDispatch.hostRequest.run.input.source, dispatchId: orphanDispatchId },
    }
    const orphanDigest = computeStartAgentRunPayloadDigest(orphanInput)
    orphanDispatch.dispatches.records.set(orphanDispatchId, executionDispatchRecordSchema.parse({
      ...originalDispatch,
      id: orphanDispatchId,
      intentId: 'intent-67676767-6767-4767-8767-676767676767',
      payloadDigest: orphanDigest,
      hostRequest: {
        ...originalDispatch.hostRequest,
        source: { ...originalDispatch.hostRequest.source, dispatchId: orphanDispatchId, payloadDigest: orphanDigest },
        run: {
          ...originalDispatch.hostRequest.run,
          input: orphanInput,
        },
      },
      state: 'pending',
      latestFencingToken: 0,
      acceptedFencingToken: undefined,
      preparation: undefined,
      operationSnapshot: undefined,
    }))
    expect(() => orphanDispatch.operations.validateDurableState(new Set(), orphanDispatch.registry))
      .toThrow('orphan or mismatched Execution Dispatch')

    const extraAnswerDispatch = harness()
    const answered = await createResolvedIntervention(extraAnswerDispatch, 'call_extra_answer_dispatch')
    const answerDispatch = extraAnswerDispatch.dispatches.records.get(answered.answer.dispatchId)
    if (answerDispatch === undefined) throw new Error('answer Dispatch is absent')
    const extraDispatchId = 'dispatch-68686868-6868-4868-8868-686868686868' as SakiExecutionDispatchId
    const extraInput = {
      ...answerDispatch.hostRequest.run.input,
      source: { ...answerDispatch.hostRequest.run.input.source, dispatchId: extraDispatchId },
    }
    const extraDigest = computeStartAgentRunPayloadDigest(extraInput)
    extraAnswerDispatch.dispatches.records.set(extraDispatchId, executionDispatchRecordSchema.parse({
      ...answerDispatch,
      id: extraDispatchId,
      payloadDigest: extraDigest,
      hostRequest: {
        ...answerDispatch.hostRequest,
        source: { ...answerDispatch.hostRequest.source, dispatchId: extraDispatchId, payloadDigest: extraDigest },
        run: {
          ...answerDispatch.hostRequest.run,
          input: extraInput,
        },
      },
      state: 'pending',
      latestFencingToken: 0,
      acceptedFencingToken: undefined,
      preparation: undefined,
      operationSnapshot: undefined,
    }))
    expect(() => extraAnswerDispatch.operations.validateDurableState(new Set(), extraAnswerDispatch.registry))
      .toThrow('orphan or mismatched Execution Dispatch')
  })

  it('rejects internally inconsistent durable Agent operation records', async () => {
    const started = harness()
    await started.operations.submit(
      intent('intent-10101010-1010-4010-8010-101010101010' as SakiControlIntentId),
      actor(),
      AbortSignal.timeout(5_000),
    )
    const retainedIntent = only(started.intents)
    const retainedSession = only(started.sessions)
    const retainedRun = only(started.runs)
    const retainedDispatch = only(started.dispatches)
    const retainedAdmission = only(started.admissions)
    if (retainedRun.hostResult === undefined) throw new Error('test Agent Run lacks Host success')

    expectSchemaIssue(agentOperationIntentRecordSchema.safeParse({
      ...retainedIntent,
      payloadDigest: retainedIntent.payloadDigest === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64),
    }), 'Agent operation Intent payload digest is stale')
    expectSchemaIssue(agentOperationIntentRecordSchema.safeParse({
      ...retainedIntent,
      terminalReason: 'protocol',
    }), 'Agent operation terminal reason disagrees with phase')
    expectSchemaIssue(agentOperationIntentRecordSchema.safeParse({
      ...retainedIntent,
      createdAt: retainedIntent.updatedAt + 1,
    }), 'Agent operation timestamps are not monotonic')

    expectSchemaIssue(workSessionRecordSchema.safeParse({
      ...retainedSession,
      agentRunIds: [retainedRun.id, retainedRun.id],
    }), 'Work Session repeats Agent Run ids')
    expectSchemaIssue(workSessionRecordSchema.safeParse({
      ...retainedSession,
      createdAt: retainedSession.updatedAt + 1,
    }), 'Work Session timestamps are not monotonic')

    expectSchemaIssue(agentRunRecordSchema.safeParse({
      ...retainedRun,
      dispatchIds: [retainedDispatch.id, retainedDispatch.id],
    }), 'Agent Run repeats Dispatch ids')
    expectSchemaIssue(agentRunRecordSchema.safeParse({
      ...retainedRun,
      createdAt: retainedRun.updatedAt + 1,
    }), 'Agent Run timestamps are not monotonic')
    expectSchemaIssue(agentRunRecordSchema.safeParse({
      ...retainedRun,
      hostResult: {
        ...retainedRun.hostResult,
        inputMessageId: '20202020-2020-4020-8020-202020202020',
      },
    }), 'Agent Run Host result disagrees with its exact input plan')
    expectSchemaIssue(agentRunRecordSchema.safeParse({
      ...retainedRun,
      state: 'starting',
    }), 'Agent Run Host result disagrees with state')

    const accepted = harness()
    accepted.execution.startMode = 'unavailable'
    await accepted.operations.submit(
      intent('intent-30303030-3030-4030-8030-303030303030' as SakiControlIntentId),
      actor(),
      AbortSignal.timeout(5_000),
    )
    const acceptedDispatch = only(accepted.dispatches)
    if (acceptedDispatch.preparation === undefined || acceptedDispatch.operationSnapshot === undefined) {
      throw new Error('test Dispatch lacks accepted Host evidence')
    }

    expectSchemaIssue(executionDispatchRecordSchema.safeParse({
      ...acceptedDispatch,
      hostRequest: {
        ...acceptedDispatch.hostRequest,
        source: { ...acceptedDispatch.hostRequest.source, payloadDigest: 'e'.repeat(64) },
      },
    }), 'Execution Dispatch disagrees with its immutable Host request')
    expectSchemaIssue(executionDispatchRecordSchema.safeParse({
      ...acceptedDispatch,
      preparation: undefined,
    }), 'accepted Execution Dispatch lacks admission evidence')
    expectSchemaIssue(executionDispatchRecordSchema.safeParse({
      ...acceptedDispatch,
      acceptedFencingToken: acceptedDispatch.latestFencingToken + 1,
    }), 'Execution Dispatch accepted fencing lacks matching preparation')
    expectSchemaIssue(executionDispatchRecordSchema.safeParse({
      ...acceptedDispatch,
      preparation: {
        ...acceptedDispatch.preparation,
        operation: {
          ...acceptedDispatch.preparation.operation,
          hostId: 'host-40404040-4040-4040-8040-404040404040',
        },
      },
    }), 'Execution Dispatch preparation disagrees with its target Host')
    expectSchemaIssue(executionDispatchRecordSchema.safeParse({
      ...acceptedDispatch,
      operationSnapshot: {
        ...acceptedDispatch.operationSnapshot,
        bindingRevision: acceptedDispatch.operationSnapshot.bindingRevision + 1,
      },
    }), 'Execution Dispatch Host snapshot disagrees with its immutable request')
    expectSchemaIssue(executionDispatchRecordSchema.safeParse({
      ...acceptedDispatch,
      operationSnapshot: {
        ...acceptedDispatch.operationSnapshot,
        requestFingerprint: {
          ...acceptedDispatch.operationSnapshot.requestFingerprint,
          digest: 'e'.repeat(64),
        },
      },
    }), 'Execution Dispatch preparation disagrees with Host snapshot')
    expectSchemaIssue(executionDispatchRecordSchema.safeParse({
      ...acceptedDispatch,
      state: 'reconciliation-required',
      terminalReason: 'authority-revoked',
    }), 'Execution Dispatch terminal reason disagrees with state')
    expectSchemaIssue(executionDispatchRecordSchema.safeParse({
      ...acceptedDispatch,
      state: 'canceled',
      terminalReason: 'protocol',
    }), 'Execution Dispatch terminal reason disagrees with state')
    expectSchemaIssue(executionDispatchRecordSchema.safeParse({
      ...acceptedDispatch,
      createdAt: acceptedDispatch.updatedAt + 1,
    }), 'Execution Dispatch timestamps are not monotonic')

    const claimed = harness()
    claimed.execution.prepareMode = 'unavailable'
    await claimed.operations.submit(
      intent('intent-50505050-5050-4050-8050-505050505050' as SakiControlIntentId),
      actor(),
      AbortSignal.timeout(5_000),
    )
    const claimedDispatch = only(claimed.dispatches)
    if (claimedDispatch.claim === undefined) throw new Error('test Dispatch lacks an active claim')
    expectSchemaIssue(executionDispatchRecordSchema.safeParse({
      ...claimedDispatch,
      state: 'pending',
    }), 'Execution Dispatch claim disagrees with state')
    expectSchemaIssue(executionDispatchRecordSchema.safeParse({
      ...claimedDispatch,
      claim: { ...claimedDispatch.claim, fencingToken: claimedDispatch.latestFencingToken + 1 },
    }), 'Execution Dispatch claim has a stale fencing token')

    if (retainedAdmission.state !== 'agent-run' || retainedAdmission.phase !== 'accepted') {
      throw new Error('test write admission is not accepted by its Agent Run')
    }
    expectSchemaIssue(bindingWriteAdmissionRecordSchema.safeParse({
      ...retainedAdmission,
      acceptedAt: retainedAdmission.updatedAt + 1,
    }), 'Agent Run admission timestamps are not monotonic')
  })

  it('freezes repeated definition headings and a default outcome through submission', async () => {
    const test = harness()
    test.execution.prepareMode = 'unavailable'
    test.issueBody = [
      'Unsectioned issue preface.',
      '# Acceptance',
      '- First criterion',
      '# Acceptance',
      '- Second criterion',
      '# Blocked by',
      'N/A',
    ].join('\n')

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } })
    const retained = only(test.intents)
    expect(retained.workItemDefinition).toMatchObject({
      intendedOutcome: 'Complete the Work Item as specified.',
      acceptanceCriteria: ['First criterion', 'Second criterion'],
      blockage: [],
    })
    const content = retained.hostRequest.run.input.content[0]
    if (content?.type !== 'text') throw new Error('frozen Agent Run input is not text')
    expect(content.text).toContain('Intended outcome:\nComplete the Work Item as specified.')
    expect(content.text).toContain('Acceptance criteria:\n- First criterion\n- Second criterion')
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
    reserved.intents.records.set(reservedIntent.id, agentOperationIntentRecordSchema.parse({
      ...reservedIntent,
      phase: 'dispatching',
    }))
    expect(() => reserved.operations.validateDurableState(new Set(), reserved.registry)).not.toThrow()
    const pendingAdmission = only(reserved.admissions)
    if (pendingAdmission.state !== 'agent-run') throw new Error('test admission is not owned by the Agent Run')
    reserved.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
      ...pendingAdmission,
      phase: 'accepted',
      acceptedAt: pendingAdmission.updatedAt,
    }))
    expect(() => reserved.operations.validateDurableState(new Set(), reserved.registry))
      .toThrow('incompatible write admission')
    reserved.intents.records.set(reservedIntent.id, agentOperationIntentRecordSchema.parse({
      ...reservedIntent,
      phase: 'admission-reserved',
    }))
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

  it.each([
    ['a missing Project', (test: Harness) => {
      test.eligibility.registry = developmentProjectRegistryRecordSchema.parse({
        ...test.registry,
        projects: [],
      })
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'expected-revision' },
    }],
    ['a stale Project revision', (test: Harness) => {
      test.eligibility.registry = developmentProjectRegistryRecordSchema.parse({
        ...test.registry,
        projects: test.registry.projects.map(project => ({ ...project, revision: project.revision + 1 })),
      })
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'expected-revision' },
    }],
    ['a missing Agent Profile', (test: Harness) => {
      test.eligibility.registry = developmentProjectRegistryRecordSchema.parse({
        ...test.registry,
        agentProfiles: [],
      })
    }, {
      ok: false,
      reason: 'unavailable',
      detail: 'agent-profile-unavailable',
    }],
    ['an Agent Profile without a Model Route', (test: Harness) => {
      test.eligibility.registry = developmentProjectRegistryRecordSchema.parse({
        ...test.registry,
        agentProfiles: test.registry.agentProfiles.map(profile => ({ ...profile, modelRouteRequest: null })),
      })
    }, {
      ok: false,
      reason: 'unavailable',
      detail: 'model-route-unavailable',
    }],
  ] as const)('rejects %s before persisting an Agent operation', async (_condition, mutate, expected) => {
    const test = harness()
    mutate(test)

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject(expected)
    expect(test.intents.size).toBe(0)
    expect(test.assignments.size).toBe(0)
    expect(test.sessions.size).toBe(0)
    expect(test.runs.size).toBe(0)
    expect(test.dispatches.size).toBe(0)
    expect(test.execution.prepareCount).toBe(0)
  })

  it.each([
    ['an unavailable Board mutation context', (test: Harness) => {
      test.eligibility.mutationContext = { ok: false, reason: 'not-found' }
    }, {
      ok: false,
      reason: 'unavailable',
      detail: 'work-item-detail-unavailable',
    }],
    ['a missing Work Item', (test: Harness) => { replaceBoardItems(test, []) }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'stale-remote' },
    }],
    ['a changed remote fingerprint', (test: Harness) => {
      patchBoardItem(test, {
        remoteFingerprint: SAKI_BOARD_MUTATION_OVERLAY_FIXTURES.conflict.workItem.remoteFingerprint,
      })
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'stale-remote' },
    }],
    ['a non-Ready Work Item', (test: Harness) => { patchBoardItem(test, { status: 'backlog' }) }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'work-item-not-ready' },
    }],
    ['a closed Issue', (test: Harness) => { patchBoardItem(test, { issueState: 'closed' }) }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'work-item-not-ready' },
    }],
    ['an archived Work Item', (test: Harness) => { patchBoardItem(test, { archived: true }) }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'work-item-not-ready' },
    }],
    ['a Work Item outside the Project', (test: Harness) => { patchBoardItem(test, { notInProject: true }) }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'work-item-not-ready' },
    }],
  ] as const)('rejects %s before durable acceptance', async (_condition, mutate, expected) => {
    const test = harness()
    mutate(test)

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject(expected)
    expect(test.intents.size).toBe(0)
    expect(test.execution.prepareCount).toBe(0)
  })

  it.each([
    ['an unavailable Binding', (test: Harness) => { test.bindingCurrent = false }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'binding-unavailable' },
    }],
    ['a stale Binding revision', (test: Harness) => { test.bindingProjectRevision += 1 }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'binding-unavailable' },
    }],
    ['a missing write-admission row', (test: Harness) => { test.admissions.records.delete(BINDING_ID) }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'binding-unavailable' },
    }],
    ['a direct Git operation holding write admission', (test: Harness) => {
      test.admissions.records.set(BINDING_ID, manualWriteAdmission())
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'writable-run-active' },
    }],
    ['an unavailable Host inspection', (test: Harness) => {
      test.eligibility.projectInspection = { ok: false, reason: 'unavailable' }
    }, {
      ok: false,
      reason: 'unavailable',
      detail: 'host-unavailable',
    }],
    ['a stale Host Binding inspection', (test: Harness) => {
      test.eligibility.projectInspection = { ok: false, reason: 'binding-stale' }
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'binding-unavailable' },
    }],
    ['an incomplete inherited-change baseline', (test: Harness) => {
      updateProjectInspection(test, current => ({
        ...current,
        preEffectBaseline: {
          kind: 'unavailable',
          reason: 'io-failure',
          observed: current.preEffectBaseline.observed,
        },
      }))
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'inherited-changes-unsafe' },
    }],
    ['a blocked structured-mutation observation', (test: Harness) => {
      updateProjectInspection(test, current => ({
        ...current,
        observation: {
          ...current.observation,
          structuredMutation: { available: false, blockers: ['unmerged'] },
        },
      }))
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'inherited-changes-unsafe' },
    }],
    ['an unmerged index', (test: Harness) => {
      updateProjectInspection(test, current => ({
        ...current,
        observation: {
          ...current.observation,
          index: { kind: 'unmerged', stagesDigest: { version: 1, digest: '9'.repeat(64) } },
        },
      }))
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'inherited-changes-unsafe' },
    }],
    ['a detached HEAD', (test: Harness) => {
      updateProjectInspection(test, current => ({
        ...current,
        observation: { ...current.observation, branch: { kind: 'detached' } },
      }))
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'binding-unavailable' },
    }],
  ] as const)('rejects %s before Host preparation', async (_condition, mutate, expected) => {
    const test = harness()
    mutate(test)

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject(expected)
    expect(test.intents.size).toBe(0)
    expect(test.execution.prepareCount).toBe(0)
  })

  it.each([
    ['an unavailable current Issue detail', (test: Harness) => {
      test.eligibility.githubReadFailure = 'issue-detail'
    }, {
      ok: false,
      reason: 'unavailable',
      detail: 'work-item-detail-unavailable',
    }],
    ['a mismatched Issue identity', (test: Harness) => {
      patchIssueDetail(test, { id: githubIssueId('I_other') })
    }, staleRemote()],
    ['a mismatched Repository identity', (test: Harness) => {
      patchIssueDetail(test, { repositoryId: githubRepositoryId('R_other') })
    }, staleRemote()],
    ['a mismatched Repository database identity', (test: Harness) => {
      patchIssueDetail(test, { repositoryDatabaseId: githubRepositoryDatabaseId('999') })
    }, staleRemote()],
    ['a mismatched Issue number', (test: Harness) => {
      patchIssueDetail(test, { number: test.eligibility.issueDetail.number + 1 })
    }, staleRemote()],
    ['a mismatched Issue title', (test: Harness) => {
      patchIssueDetail(test, { title: `${test.eligibility.issueDetail.title} changed` })
    }, staleRemote()],
    ['a mismatched Issue URL', (test: Harness) => {
      patchIssueDetail(test, { url: `${test.eligibility.issueDetail.url}?changed=1` })
    }, staleRemote()],
    ['a mismatched Issue state', (test: Harness) => {
      patchIssueDetail(test, { state: 'closed' })
    }, staleRemote()],
    ['a newer Issue revision', (test: Harness) => {
      patchIssueDetail(test, { updatedAt: test.eligibility.issueDetail.updatedAt + 1 })
    }, staleRemote()],
    ['an Issue without acceptance criteria', (test: Harness) => {
      patchIssueDetail(test, { body: '# Intended outcome\nShip the vertical slice.' })
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'acceptance-criteria-missing' },
    }],
    ['an Issue with a nonempty blocker', (test: Harness) => {
      patchIssueDetail(test, {
        body: '# Intended outcome\nShip the vertical slice.\n# Acceptance criteria\n- It ships\n# Blocked by\n- Upstream API',
      })
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'work-item-blocked' },
    }],
    ['an unavailable branch-safety observation', (test: Harness) => {
      test.eligibility.githubReadFailure = 'branch-safety'
    }, {
      ok: false,
      reason: 'unavailable',
      detail: 'branch-safety-unavailable',
    }],
    ['a protected current branch', (test: Harness) => {
      test.eligibility.branchSafety = { kind: 'protected', branchExists: true, observedAt: 2 }
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'branch-protected' },
    }],
    ['an unknown legacy branch protection', (test: Harness) => {
      test.eligibility.branchSafety = { kind: 'legacy-protection-unknown', branchExists: false, observedAt: 2 }
    }, {
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'legacy-protection-unknown' },
    }],
  ] as const)('rejects %s before durable acceptance', async (_condition, mutate, expected) => {
    const test = harness()
    mutate(test)

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject(expected)
    expect(test.intents.size).toBe(0)
    expect(test.execution.prepareCount).toBe(0)
  })

  it.each([
    ['before eligibility', (test: Harness) => { test.authorityCurrent = false }, 0],
    ['after Model Route resolution', (test: Harness) => {
      test.afterResolveModelRoute = () => { test.authorityCurrent = false }
    }, 1],
  ] as const)('denies revoked authority %s without persisting an Agent operation', async (
    _checkpoint,
    revoke,
    expectedRouteCount,
  ) => {
    const test = harness()
    revoke(test)

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toEqual({
      ok: false,
      reason: 'denied',
    })
    expect(test.resolvedModelRoutes).toHaveLength(expectedRouteCount)
    expect(test.intents.size).toBe(0)
    expect(test.assignments.size).toBe(0)
    expect(test.sessions.size).toBe(0)
    expect(test.runs.size).toBe(0)
    expect(test.dispatches.size).toBe(0)
    expect(test.execution.prepareCount).toBe(0)
  })

  it('owns one disposable GitHub reader and fails closed while it is detached', async () => {
    const test = harness()

    expect(() => { test.attachDuplicateGitHub() }).toThrow('already have a GitHub reader')
    test.detachGitHub()
    test.detachGitHub()

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'work-item-detail-unavailable',
    })
    expect(test.intents.size).toBe(0)
  })

  it('rejects a replayed Intent id carrying different browser input', async () => {
    const test = harness()
    const submitted = intent()
    await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
    const conflicting = giveWorkItemToAgentIntentSchema.parse({
      ...submitted,
      expectedRemoteFingerprint: `remote-fingerprint-${'4'.repeat(64)}`,
    })

    expect(await test.operations.submit(conflicting, actor(), AbortSignal.timeout(5_000))).toEqual({
      ok: false,
      reason: 'conflict',
    })
    expect(test.runs.size).toBe(1)
    expect(test.execution.startCount).toBe(1)
  })

  it.each([
    ['Intent', 'before', (test: Harness) => test.intents, false],
    ['Intent', 'after', (test: Harness) => test.intents, true],
    ['initial Assignment', 'before', (test: Harness) => test.assignments, false],
    ['initial Assignment', 'after', (test: Harness) => test.assignments, true],
  ] as const)('handles a %s put failure %s commit', async (_record, failure, table, committed) => {
    const test = harness()
    table(test).failNextPut = failure
    const submitted = test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))

    if (committed) {
      await expect(submitted).resolves.toMatchObject({ ok: true, receipt: { state: 'started' } })
    } else {
      await expect(submitted).rejects.toThrow('injected put failure')
    }
  })

  it('rejects an incompatible pre-existing child while materializing a retained Intent', async () => {
    const test = harness()
    test.assignments.failNextPut = 'before'
    await expect(test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow('injected put failure')
    const retained = only(test.intents)
    test.assignments.records.set(retained.assignmentId, workAssignmentRecordSchema.parse({
      id: retained.assignmentId,
      schemaVersion: 2,
      revision: 0,
      intentId: retained.id,
      projectId: 'project-60606060-6060-4060-8060-606060606060',
      workItemId: retained.payload.intent.workItemId,
      ownerPrincipalId: retained.payload.actor.principalId,
      primaryWorkSessionId: retained.workSessionId,
      agentRunId: retained.agentRunId,
      state: 'assigned',
      createdAt: retained.createdAt,
      updatedAt: retained.createdAt,
    }))

    await expect(test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow(`Saki child '${retained.assignmentId}' conflicts`)
  })

  it('rejects a concurrent record revision change instead of overwriting it', async () => {
    const test = harness()
    test.afterResolveModelRoute = () => {
      test.intents.beforeNextUpdate = () => {
        const retained = only(test.intents)
        test.intents.records.set(retained.id, agentOperationIntentRecordSchema.parse({
          ...retained,
          revision: retained.revision + 1,
          updatedAt: retained.updatedAt + 1,
        }))
      }
    }

    await expect(test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow()
    expect(only(test.intents)).toMatchObject({ revision: 1, phase: 'prepared' })
  })

  it.each([
    ['a deleted admission row', (test: Harness) => { test.admissions.records.delete(BINDING_ID) }],
    ['a direct Git operation', (test: Harness) => {
      test.admissions.records.set(BINDING_ID, manualWriteAdmission())
    }],
    ['another Agent Run', (test: Harness) => {
      test.admissions.records.set(BINDING_ID, foreignAgentWriteAdmission())
    }],
  ] as const)('keeps a prepared operation retryable when %s wins after eligibility', async (_holder, occupy) => {
    const test = harness()
    test.afterResolveModelRoute = () => { occupy(test) }

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'prepared' },
    })
    expect(only(test.intents)).toMatchObject({ phase: 'prepared' })
    expect(test.execution.prepareCount).toBe(0)
  })

  it('adopts an exact admission reservation whose storage acknowledgement was lost', async () => {
    const test = harness()
    test.afterResolveModelRoute = () => {
      test.admissions.afterNextUpdate = () => { throw new Error('simulated admission acknowledgement loss') }
    }

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: true, receipt: { state: 'started' } })
    expect(only(test.admissions)).toMatchObject({ state: 'agent-run', phase: 'accepted' })
    expect(test.execution.startCount).toBe(1)
  })

  it('propagates an admission storage failure that did not commit its reservation', async () => {
    const test = harness()
    test.afterResolveModelRoute = () => {
      test.admissions.beforeNextUpdate = () => { throw new Error('simulated admission storage failure') }
    }

    await expect(test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow('simulated admission storage failure')
    expect(only(test.admissions)).toMatchObject({ state: 'available' })
    expect(only(test.intents)).toMatchObject({ phase: 'prepared' })
    expect(test.execution.prepareCount).toBe(0)
  })

  it('rejects a stale Binding revision in a replayed admission reservation', async () => {
    const test = harness()
    test.afterResolveModelRoute = () => {
      test.admissions.afterNextUpdate = () => {
        const reserved = only(test.admissions)
        if (reserved.state !== 'agent-run') throw new Error('test admission was not reserved')
        test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
          ...reserved,
          revision: reserved.revision + 1,
          bindingRevision: reserved.bindingRevision + 1,
          updatedAt: reserved.updatedAt + 1,
        }))
        throw new Error('simulated stale reservation acknowledgement')
      }
    }

    await expect(test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow('simulated stale reservation acknowledgement')
    expect(only(test.intents)).toMatchObject({ phase: 'prepared' })
    expect(only(test.admissions)).toMatchObject({ state: 'agent-run', phase: 'reserved' })
    expect(test.execution.prepareCount).toBe(0)
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

  it('returns the admission-reserved receipt while another executor owns the current claim', async () => {
    const test = harness()
    const submitted = intent('intent-62626262-6262-4262-8262-626262626262' as SakiControlIntentId)
    test.intents.simulateCrashAfterUpdateWhen(record => record.phase === 'admission-reserved')
    await expect(test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow(SimulatedProcessCrash)
    const pending = only(test.dispatches)
    const now = Date.now()
    test.dispatches.records.set(pending.id, executionDispatchRecordSchema.parse({
      ...pending,
      revision: pending.revision + 1,
      state: 'claimed',
      latestFencingToken: 1,
      claim: {
        id: 'dispatch-claim-63636363-6363-4363-8363-636363636363',
        executorHostId: 'host-64646464-6464-4464-8464-646464646464',
        fencingToken: 1,
        issuedAt: now,
        expiresAt: now + 30_000,
      },
      updatedAt: Math.max(pending.updatedAt, now),
    }))
    test.restart()

    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'admission-reserved' },
    })
    expect(test.execution.prepareCount).toBe(0)
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

  it('reuses a current claim without a write when its requested expiry is unchanged', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const test = harness()
      test.execution.prepareMode = 'unavailable'
      await test.operations.submit(intent(), actor(), new AbortController().signal)
      const first = only(test.dispatches)

      await test.operations.submit(intent(), actor(), new AbortController().signal)

      expect(only(test.dispatches)).toEqual(first)
      expect(test.execution.prepareCount).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('adopts an exact claim renewal whose storage acknowledgement was lost', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const test = harness()
      test.execution.prepareMode = 'unavailable'
      await test.operations.submit(intent(), actor(), new AbortController().signal)
      const first = only(test.dispatches)
      test.dispatches.afterNextUpdate = () => { throw new Error('simulated claim acknowledgement loss') }
      vi.setSystemTime(2_000)

      expect(await test.operations.submit(intent(), actor(), new AbortController().signal))
        .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } })
      expect(only(test.dispatches)).toMatchObject({
        revision: first.revision + 1,
        state: 'claimed',
        latestFencingToken: 1,
        claim: { id: first.claim?.id, fencingToken: 1, expiresAt: 32_000 },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates a claim-renewal storage failure that committed no write', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const test = harness()
      test.execution.prepareMode = 'unavailable'
      await test.operations.submit(intent(), actor(), new AbortController().signal)
      const first = only(test.dispatches)
      test.dispatches.beforeNextUpdate = () => { throw new Error('simulated claim storage failure') }
      vi.setSystemTime(2_000)

      await expect(test.operations.submit(intent(), actor(), new AbortController().signal))
        .rejects.toThrow('simulated claim storage failure')
      expect(only(test.dispatches)).toEqual(first)
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

  it.each(['claim identity', 'executor identity', 'fencing token'] as const)(
    'rejects a changed Dispatch %s after Host preparation',
    async (changed) => {
      const test = harness()
      test.execution.afterPrepare = () => {
        const current = only(test.dispatches)
        if (current.state !== 'claimed' || current.claim === undefined) {
          throw new Error('test Dispatch was not claimed')
        }
        const claim = {
          ...current.claim,
          ...(changed === 'claim identity'
            ? { id: 'dispatch-claim-45454545-4545-4545-8545-454545454545' }
            : changed === 'executor identity'
              ? { executorHostId: 'host-46464646-4646-4646-8646-464646464646' }
              : { fencingToken: current.claim.fencingToken + 1 }),
        }
        test.dispatches.records.set(current.id, executionDispatchRecordSchema.parse({
          ...current,
          latestFencingToken: claim.fencingToken,
          claim,
        }))
      }

      expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
        .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } })
      expect(only(test.dispatches)).toMatchObject({ state: 'claimed' })
      expect(only(test.admissions)).toMatchObject({ state: 'agent-run', phase: 'reserved' })
      expect(test.execution.prepareCount).toBe(1)
      expect(test.execution.startCount).toBe(0)
    },
  )

  it.each(['source-conflict', 'terminal-failed'] as const)(
    'retains write ownership when Host preparation reports %s',
    async (prepareMode) => {
      const test = harness()
      test.execution.prepareMode = prepareMode

      expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject({
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'protocol' },
      })
      expect(only(test.dispatches)).toMatchObject({ state: 'reconciliation-required', terminalReason: 'protocol' })
      expect(only(test.admissions)).toMatchObject({ state: 'agent-run', phase: 'accepted' })
      expect(only(test.runs)).toMatchObject({ state: 'reconciliation-required' })
      expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
    },
  )

  it.each([
    ['preparation fingerprint', (receipt: Extract<HostOperationReceipt<'start-agent-run'>, { readonly ok: true }>) => ({
      ...receipt,
      preparation: {
        ...receipt.preparation,
        requestFingerprint: { ...receipt.preparation.requestFingerprint, digest: 'e'.repeat(64) },
      },
    }), 'Host preparation disagrees'],
    ['snapshot source', (receipt: Extract<HostOperationReceipt<'start-agent-run'>, { readonly ok: true }>) => ({
      ...receipt,
      snapshot: {
        ...receipt.snapshot,
        source: { ...receipt.snapshot.source, payloadDigest: 'e'.repeat(64) },
      },
    }), 'Host snapshot disagrees'],
  ] as const)('rejects Host preparation with mismatched %s', async (_evidence, mutate, message) => {
    const test = harness()
    test.execution.prepareResult = mutate

    await expect(test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).rejects.toThrow(message)
    expect(test.execution.startCount).toBe(0)
  })

  it.each([
    ['before the post-prepare read', (test: Harness) => {
      test.execution.afterPrepare = () => { test.dispatches.records.clear() }
    }],
    ['during the preparation write', (test: Harness) => {
      test.execution.afterPrepare = () => {
        test.dispatches.beforeNextUpdate = () => {
          test.dispatches.records.clear()
          throw new Error('simulated concurrent Dispatch deletion')
        }
      }
    }],
    ['after the preparation write', (test: Harness) => {
      test.execution.afterPrepare = () => {
        test.dispatches.afterNextUpdate = () => { test.dispatches.records.clear() }
      }
    }],
  ] as const)('keeps the operation retryable when its Dispatch disappears %s', async (_checkpoint, inject) => {
    const test = harness()
    inject(test)

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } })
    expect(test.dispatches.size).toBe(0)
    expect(test.execution.startCount).toBe(0)
  })

  it('propagates a preparation storage failure while retaining the exact claim owner', async () => {
    const test = harness()
    test.execution.afterPrepare = () => {
      test.dispatches.beforeNextUpdate = () => { throw new Error('simulated preparation storage failure') }
    }

    await expect(test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow('simulated preparation storage failure')
    const dispatch = only(test.dispatches)
    expect(dispatch).toMatchObject({ state: 'claimed' })
    expect(dispatch.operationSnapshot).toBeUndefined()
    expect(test.execution.startCount).toBe(0)
  })

  it('adopts an exact preparation write whose storage acknowledgement was lost', async () => {
    const test = harness()
    test.execution.afterPrepare = () => {
      test.dispatches.afterNextUpdate = () => { throw new Error('simulated preparation acknowledgement loss') }
    }

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: true, receipt: { state: 'started' } })
    expect(test.execution.startCount).toBe(1)
  })

  it('adopts an accepted Dispatch whose storage acknowledgement was lost', async () => {
    const test = harness()
    test.execution.afterPrepare = () => {
      test.admissions.afterNextUpdate = () => {
        test.dispatches.afterNextUpdate = () => { throw new Error('simulated acceptance acknowledgement loss') }
      }
    }

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: true, receipt: { state: 'started' } })
    expect(only(test.dispatches)).toMatchObject({ state: 'accepted', acceptedFencingToken: 1 })
    expect(test.execution.startCount).toBe(1)
  })

  it('propagates a final Dispatch acceptance write failure that committed no state', async () => {
    const test = harness()
    test.execution.afterPrepare = () => {
      test.admissions.afterNextUpdate = () => {
        test.dispatches.beforeNextUpdate = () => { throw new Error('simulated final acceptance storage failure') }
      }
    }

    await expect(test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow('simulated final acceptance storage failure')
    expect(only(test.dispatches)).toMatchObject({ state: 'claimed', operationSnapshot: { state: 'prepared' } })
    expect(test.execution.startCount).toBe(0)
  })

  it.each([
    ['replacement', (current: Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run' }>) =>
      bindingWriteAdmissionRecordSchema.parse({
        id: BINDING_ID,
        schemaVersion: 1,
        revision: current.revision + 1,
        state: 'available',
        updatedAt: current.updatedAt + 1,
      }), { state: 'available' }],
    ['binding-revision tampering', (current: Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run' }>) =>
      bindingWriteAdmissionRecordSchema.parse({
        ...current,
        revision: current.revision + 1,
        bindingRevision: current.bindingRevision + 1,
        updatedAt: current.updatedAt + 1,
      }), { state: 'agent-run', phase: 'reserved' }],
  ] as const)('rejects write-admission %s after Host preparation', async (_condition, mutate, expectedAdmission) => {
    const test = harness()
    test.execution.afterPrepare = () => {
      const current = only(test.admissions)
      if (current.state !== 'agent-run') throw new Error('test admission is not reserved for its Agent Run')
      test.admissions.records.set(BINDING_ID, mutate(current))
    }

    await expect(test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow()
    expect(only(test.dispatches)).toMatchObject({ state: 'claimed', operationSnapshot: { state: 'prepared' } })
    expect(only(test.admissions)).toMatchObject(expectedAdmission)
    expect(test.execution.startCount).toBe(0)
  })

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

  it('cancels without effect when authority is revoked before Host admission', async () => {
    const test = harness()
    test.execution.beforeAdmission = () => { test.authorityCurrent = false }

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'canceled',
      receipt: { state: 'canceled', reason: 'authority-revoked' },
    })
    expect(only(test.dispatches)).toMatchObject({
      state: 'accepted',
      operationSnapshot: { state: 'canceled', reason: 'authority-revoked', effect: 'none' },
    })
    expect(only(test.assignments)).toMatchObject({ state: 'canceled' })
    expect(only(test.sessions)).toMatchObject({ state: 'canceled' })
    expect(only(test.runs)).toMatchObject({ state: 'canceled' })
    expect(only(test.admissions)).toMatchObject({ state: 'available' })
    expect(test.execution.startCount).toBe(1)
    expect(test.execution.cancelCount).toBe(1)
    expect(test.moves).toHaveLength(0)
  })

  it('denies Host admission after its retained Binding revision changes', async () => {
    const test = harness()
    test.execution.beforeAdmission = () => {
      const accepted = only(test.admissions)
      if (accepted.state !== 'agent-run') throw new Error('test admission was not accepted')
      test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
        ...accepted,
        revision: accepted.revision + 1,
        bindingRevision: accepted.bindingRevision + 1,
        updatedAt: accepted.updatedAt + 1,
      }))
    }

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'protocol' },
    })
    expect(test.moves).toHaveLength(0)
    expect(only(test.dispatches)).toMatchObject({
      state: 'reconciliation-required',
      operationSnapshot: { state: 'canceled', reason: 'source-canceled', effect: 'none' },
    })
  })

  it.each([
    ['source kind', (value: HostOperationAdmissionExpectation) => ({
      ...value,
      source: {
        kind: 'control-intent' as const,
        intentId: 'intent-58585858-5858-4858-8858-585858585858' as SakiControlIntentId,
        intentRevision: 0,
        payloadDigest: value.source.payloadDigest,
      },
    })],
    ['source evidence', (value: HostOperationAdmissionExpectation) => ({
      ...value,
      source: { ...value.source, payloadDigest: 'f'.repeat(64) },
    })],
    ['preparation', (value: HostOperationAdmissionExpectation) => ({
      ...value,
      preparation: {
        ...value.preparation,
        requestFingerprint: { ...value.preparation.requestFingerprint, digest: 'f'.repeat(64) },
      },
    })],
    ['Binding id', (value: HostOperationAdmissionExpectation) => ({
      ...value,
      bindingId: 'binding-59595959-5959-4959-8959-595959595959' as SakiResourceBindingId,
    })],
    ['Binding revision', (value: HostOperationAdmissionExpectation) => ({
      ...value,
      bindingRevision: value.bindingRevision + 1,
    })],
  ] as const)('denies Host admission with stale %s', async (_evidence, mutate) => {
    const test = harness()
    test.execution.admissionExpectation = mutate

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'protocol' },
    })
    expect(test.moves).toHaveLength(0)
  })

  it.each([
    ['Dispatch', (test: Harness) => { test.dispatches.records.clear() }],
    ['Intent', (test: Harness) => { test.intents.records.clear() }],
  ] as const)('fails closed when the accepted %s disappears before Host admission', async (_owner, remove) => {
    const test = harness()
    test.execution.beforeAdmission = () => { remove(test) }

    await expect(test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).rejects.toThrow('missing-key')
    expect(test.moves).toHaveLength(0)
  })

  it.each([
    ['is missing', (test: Harness) => { test.admissions.records.clear() }],
    ['is malformed', (test: Harness) => { test.admissions.records.set(BINDING_ID, { malformed: true } as never) }],
  ] as const)('returns unavailable when the accepted admission %s at the Host boundary', async (_state, mutate) => {
    const test = harness()
    test.execution.beforeAdmission = () => { mutate(test) }

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'dispatching' },
    })
    expect(test.moves).toHaveLength(0)
  })

  it.each([
    ['becomes unavailable', (test: Harness) => { test.bindingCurrent = false }],
    ['changes Project revision', (test: Harness) => { test.bindingProjectRevision += 1 }],
  ] as const)('denies Host admission when the current Binding %s', async (_change, mutate) => {
    const test = harness()
    test.execution.beforeAdmission = () => { mutate(test) }

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'protocol' },
    })
    expect(test.moves).toHaveLength(0)
  })

  it.each([
    ['succeeded', {
      result: { ok: true, receipt: { state: 'started' } },
      intentState: 'started',
      runState: 'running',
      moves: 1,
    }],
    ['reconciliation', {
      result: {
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'effect-unknown' },
      },
      intentState: 'reconciliation-required',
      runState: 'reconciliation-required',
      moves: 0,
    }],
    ['nonterminal', {
      result: { ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } },
      intentState: 'dispatching',
      runState: 'starting',
      moves: 0,
    }],
  ] as const)('adopts a %s Host cancellation result after effect-boundary authority denial', async (
    cancelMode,
    expected,
  ) => {
    const test = harness()
    test.execution.beforeAdmission = () => { test.authorityCurrent = false }
    test.execution.cancelMode = cancelMode

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .toMatchObject(expected.result)
    expect(only(test.intents)).toMatchObject({ phase: expected.intentState })
    expect(only(test.runs)).toMatchObject({ state: expected.runState })
    expect(test.moves).toHaveLength(expected.moves)
  })

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
    ['after admission reservation', (test: Harness) => {
      test.afterResolveModelRoute = () => {
        test.admissions.simulateCrashAfterUpdateWhen(admission => admission.state === 'agent-run'
          && admission.phase === 'reserved')
      }
    }],
    ['after Host preparation', (test: Harness) => {
      test.execution.afterPrepare = () => {
        throw new SimulatedProcessCrash('Host preparation committed before the process stopped')
      }
    }],
    ['after recording Host preparation', (test: Harness) => {
      test.execution.afterPrepare = () => {
        test.dispatches.afterNextUpdate = () => {
          test.admissions.beforeNextUpdate = () => {
            throw new SimulatedProcessCrash('process stopped before accepting the prepared operation')
          }
        }
      }
    }],
    ['after admission acceptance', (test: Harness) => {
      test.execution.afterPrepare = () => {
        test.dispatches.afterNextUpdate = () => {
          test.admissions.afterNextUpdate = () => {
            test.dispatches.beforeNextUpdate = () => {
              throw new SimulatedProcessCrash('process stopped before accepting the prepared Dispatch')
            }
          }
        }
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

  it('replays retained nonterminal Intents after restoring running Host operations', async () => {
    const test = harness()
    const submitted = intent('intent-47474747-4747-4747-8747-474747474747' as SakiControlIntentId)
    test.execution.startMode = 'unavailable'
    await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
    const state = test.operations.validateDurableState(new Set(), test.registry)
    expect(state.intents).toHaveLength(1)
    expect(state.runningAgentRuns).toHaveLength(0)
    test.execution.startMode = 'success'

    await expect(test.operations.initializeValidated(state)).resolves.toBeUndefined()

    expect(only(test.intents)).toMatchObject({ phase: 'started' })
    expect(only(test.runs)).toMatchObject({ state: 'running' })
    expect(test.moves).toHaveLength(1)
  })

  it('reacts only to relevant nonterminal Host wake-ups and contains recovery failure', async () => {
    const completed = harness()
    await completed.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const completedOperation = only(completed.dispatches).preparation?.operation
    if (completedOperation === undefined) throw new Error('test Dispatch lacks Host preparation')
    completed.operations.hostChanged({
      operation: {
        ...completedOperation,
        id: 'host-operation-48484848-4848-4848-8848-484848484848' as HostOperationId,
      },
      revision: 1,
    })
    completed.operations.hostChanged({ operation: completedOperation, revision: 2 })
    await completed.operations.dispose()
    expect(completed.execution.startCount).toBe(1)

    const missing = harness()
    missing.execution.startMode = 'unavailable'
    await missing.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const missingDispatch = only(missing.dispatches)
    const missingOperation = missingDispatch.preparation?.operation
    if (missingOperation === undefined) throw new Error('test Dispatch lacks Host preparation')
    missing.intents.records.delete(missingDispatch.intentId)
    missing.operations.hostChanged({ operation: missingOperation, revision: 1 })
    await missing.operations.dispose()
    expect(missing.execution.startCount).toBe(1)

    const recovered = harness()
    recovered.execution.startMode = 'unavailable'
    await recovered.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const recoveredOperation = only(recovered.dispatches).preparation?.operation
    if (recoveredOperation === undefined) throw new Error('test Dispatch lacks Host preparation')
    recovered.execution.startMode = 'success'
    recovered.operations.hostChanged({ operation: recoveredOperation, revision: 1 })
    await recovered.operations.dispose()
    expect(only(recovered.intents)).toMatchObject({ phase: 'started' })
    expect(recovered.moves).toHaveLength(1)

    const failed = harness()
    failed.execution.startMode = 'unavailable'
    await failed.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const failedOperation = only(failed.dispatches).preparation?.operation
    if (failedOperation === undefined) throw new Error('test Dispatch lacks Host preparation')
    failed.execution.inspectError = new Error('simulated notification recovery failure')
    failed.operations.hostChanged({ operation: failedOperation, revision: 1 })
    await expect(failed.operations.dispose()).resolves.toBeUndefined()
    expect(only(failed.intents)).toMatchObject({ phase: 'dispatching' })
  })

  it.each([
    ['reconciliation-required', 'reconciliation', {
      result: {
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'effect-unknown' },
      },
      dispatch: { state: 'reconciliation-required', terminalReason: 'effect-unknown' },
      runState: 'reconciliation-required',
      admissionState: 'agent-run',
    }],
    ['failed', 'failed', {
      result: {
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'protocol' },
      },
      dispatch: {
        state: 'reconciliation-required',
        terminalReason: 'protocol',
        operationSnapshot: { state: 'failed', effect: 'none' },
      },
      runState: 'reconciliation-required',
      admissionState: 'agent-run',
    }],
    ['source-canceled', 'canceled-source', {
      result: {
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'protocol' },
      },
      dispatch: {
        state: 'reconciliation-required',
        terminalReason: 'protocol',
        operationSnapshot: { state: 'canceled', reason: 'source-canceled', effect: 'none' },
      },
      runState: 'reconciliation-required',
      admissionState: 'agent-run',
    }],
    ['authority-canceled', 'canceled-authority', {
      result: {
        ok: false,
        reason: 'canceled',
        receipt: { state: 'canceled', reason: 'authority-revoked' },
      },
      dispatch: {
        state: 'accepted',
        operationSnapshot: { state: 'canceled', reason: 'authority-revoked', effect: 'none' },
      },
      runState: 'canceled',
      admissionState: 'available',
    }],
  ] as const)('adopts %s Host evidence while recovering an accepted Dispatch', async (
    _evidence,
    inspectMode,
    expected,
  ) => {
    const test = harness()
    test.execution.startMode = 'unavailable'
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    test.execution.inspectMode = inspectMode

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .toMatchObject(expected.result)
    expect(only(test.dispatches)).toMatchObject(expected.dispatch)
    expect(only(test.runs)).toMatchObject({ state: expected.runState })
    expect(only(test.admissions)).toMatchObject({ state: expected.admissionState })
    expect(test.moves).toHaveLength(0)
  })

  it.each([
    ['unavailable', {
      result: { ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } },
      dispatch: { state: 'accepted' },
    }],
    ['source-conflict', {
      result: {
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'protocol' },
      },
      dispatch: { state: 'reconciliation-required', terminalReason: 'protocol' },
    }],
  ] as const)('handles an exact accepted-Dispatch preparation replay that becomes %s', async (prepareMode, expected) => {
    const test = harness()
    test.execution.startMode = 'unavailable'
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    test.execution.prepareMode = prepareMode

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .toMatchObject(expected.result)
    expect(only(test.dispatches)).toMatchObject(expected.dispatch)
    expect(test.execution.startCount).toBe(1)
  })

  it('reconciles an accepted Dispatch whose retained Run entered an incompatible terminal state', async () => {
    const test = harness()
    test.execution.startMode = 'unavailable'
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const run = only(test.runs)
    test.runs.records.set(run.id, agentRunRecordSchema.parse({ ...run, state: 'canceled' }))

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'protocol' },
    })
    expect(only(test.runs)).toMatchObject({ state: 'reconciliation-required' })
    expect(test.execution.startCount).toBe(1)
  })

  it('finishes a retained succeeded Dispatch without rewriting already-finalized Run children', async () => {
    const test = harness()
    const submitted = intent('intent-42424242-4242-4242-8242-424242424242' as SakiControlIntentId)
    await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
    const retained = only(test.intents)
    test.intents.records.set(retained.id, agentOperationIntentRecordSchema.parse({
      ...retained,
      phase: 'dispatching',
    }))

    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
      .toMatchObject({ ok: true, receipt: { state: 'started' } })
    expect(only(test.runs)).toMatchObject({ state: 'running', revision: 2 })
    expect(only(test.assignments)).toMatchObject({ state: 'active', revision: 1 })
    expect(test.moves).toHaveLength(2)
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

  it.each([
    ['failed', {
      result: {
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'protocol' },
      },
      dispatchState: 'reconciliation-required',
      runState: 'reconciliation-required',
      admissionState: 'agent-run',
    }],
    ['canceled-source', {
      result: {
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'protocol' },
      },
      dispatchState: 'reconciliation-required',
      runState: 'reconciliation-required',
      admissionState: 'agent-run',
    }],
    ['canceled-authority', {
      result: {
        ok: false,
        reason: 'canceled',
        receipt: { state: 'canceled', reason: 'authority-revoked' },
      },
      dispatchState: 'accepted',
      runState: 'canceled',
      admissionState: 'available',
    }],
  ] as const)('adopts a %s terminal Host start outcome', async (startMode, expected) => {
    const test = harness()
    test.execution.startMode = startMode

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .toMatchObject(expected.result)
    expect(only(test.dispatches)).toMatchObject({
      state: expected.dispatchState,
      operationSnapshot: {
        state: startMode === 'failed' ? 'failed' : 'canceled',
        effect: 'none',
      },
    })
    expect(only(test.runs)).toMatchObject({ state: expected.runState })
    expect(only(test.admissions)).toMatchObject({ state: expected.admissionState })
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

  it('keeps a revoked claimed Dispatch retryable while exact Host preparation is unavailable', async () => {
    const test = harness()
    test.execution.prepareMode = 'unavailable'
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    test.authorityCurrent = false

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'dispatching' },
    })
    expect(only(test.dispatches)).toMatchObject({ state: 'claimed' })
    expect(test.execution.cancelCount).toBe(0)
  })

  it('recovers a committed canceled Dispatch prefix without canceling the Host twice', async () => {
    const test = harness()
    const submitted = intent('intent-61616161-6161-4161-8161-616161616161' as SakiControlIntentId)
    test.execution.prepareMode = 'unavailable'
    await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
    test.authorityCurrent = false
    test.execution.prepareMode = 'success'
    test.dispatches.simulateCrashAfterUpdateWhen(dispatch => dispatch.state === 'canceled')

    await expect(test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow(SimulatedProcessCrash)
    expect(only(test.dispatches)).toMatchObject({ state: 'canceled', terminalReason: 'authority-revoked' })
    test.restart()

    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'canceled',
      receipt: { state: 'canceled', reason: 'authority-revoked' },
    })
    expect(test.execution.cancelCount).toBe(1)
  })

  it.each([
    ['disappears', (test: Harness) => { test.admissions.records.clear() }, false],
    ['changes owner', (test: Harness) => { test.admissions.records.set(BINDING_ID, foreignAgentWriteAdmission()) }, true],
  ] as const)('protects terminal admission release when its row %s before the read', async (
    _change,
    mutate,
    completes,
  ) => {
    const test = harness()
    test.execution.beforeAdmission = () => {
      test.authorityCurrent = false
      test.runs.afterNextUpdate = () => { mutate(test) }
    }
    const submitted = test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))

    if (completes) {
      await expect(submitted).resolves.toMatchObject({ ok: false, reason: 'canceled' })
      expect(only(test.admissions)).toMatchObject({ state: 'agent-run' })
    } else {
      await expect(submitted).rejects.toThrow()
    }
  })

  it.each([
    ['becomes available', (test: Harness) => {
      const current = only(test.admissions)
      test.admissions.records.set(BINDING_ID, bindingWriteAdmissionRecordSchema.parse({
        id: BINDING_ID,
        schemaVersion: 1,
        revision: current.revision + 1,
        state: 'available',
        updatedAt: current.updatedAt + 1,
      }))
    }, true],
    ['changes owner', (test: Harness) => {
      test.admissions.records.set(BINDING_ID, foreignAgentWriteAdmission())
    }, false],
  ] as const)('protects terminal admission release when its row %s during the write', async (
    _change,
    mutate,
    completes,
  ) => {
    const test = harness()
    test.execution.beforeAdmission = () => {
      test.authorityCurrent = false
      test.runs.afterNextUpdate = () => {
        test.admissions.beforeNextUpdate = () => { mutate(test) }
      }
    }
    const submitted = test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))

    if (completes) {
      await expect(submitted).resolves.toMatchObject({ ok: false, reason: 'canceled' })
      expect(only(test.admissions)).toMatchObject({ state: 'available' })
    } else {
      await expect(submitted).rejects.toThrow()
      expect(only(test.admissions)).toMatchObject({ state: 'agent-run' })
    }
  })

  it.each([
    ['succeeded', {
      result: { ok: true, receipt: { state: 'started' } },
      dispatch: { state: 'accepted', operationSnapshot: { state: 'succeeded' } },
      intentState: 'started',
      runState: 'running',
      admissionState: 'agent-run',
      moves: 1,
    }],
    ['reconciliation', {
      result: {
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'effect-unknown' },
      },
      dispatch: { state: 'reconciliation-required', terminalReason: 'effect-unknown' },
      intentState: 'reconciliation-required',
      runState: 'reconciliation-required',
      admissionState: 'agent-run',
      moves: 0,
    }],
    ['failed', {
      result: { ok: false, reason: 'canceled', receipt: { state: 'canceled' } },
      dispatch: { state: 'accepted', operationSnapshot: { state: 'failed', effect: 'none' } },
      intentState: 'canceled',
      runState: 'canceled',
      admissionState: 'available',
      moves: 0,
    }],
    ['nonterminal', {
      result: { ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } },
      dispatch: { state: 'accepted', operationSnapshot: { state: 'prepared' } },
      intentState: 'dispatching',
      runState: 'starting',
      admissionState: 'agent-run',
      moves: 0,
    }],
  ] as const)('adopts a %s Host cancellation outcome after authority revocation', async (cancelMode, expected) => {
    const test = harness()
    test.execution.startMode = 'unavailable'
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    test.authorityCurrent = false
    test.execution.cancelMode = cancelMode

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000)))
      .toMatchObject(expected.result)
    expect(only(test.dispatches)).toMatchObject(expected.dispatch)
    expect(only(test.intents)).toMatchObject({ phase: expected.intentState })
    expect(only(test.runs)).toMatchObject({ state: expected.runState })
    expect(only(test.admissions)).toMatchObject({ state: expected.admissionState })
    expect(test.moves).toHaveLength(expected.moves)
  })

  it('recovers accepted admission ownership after stopping before recording a Host source conflict', async () => {
    const test = harness()
    test.execution.prepareMode = 'unavailable'
    const submitted = intent('intent-41414141-4141-4141-8141-414141414141' as SakiControlIntentId)
    await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
    const claimed = only(test.dispatches)
    expect(claimed).toMatchObject({ state: 'claimed' })
    expect(claimed.preparation).toBeUndefined()

    test.authorityCurrent = false
    test.execution.prepareMode = 'source-conflict'
    test.admissions.afterNextUpdate = () => {
      test.dispatches.beforeNextUpdate = () => {
        throw new SimulatedProcessCrash('process stopped before recording Host source conflict')
      }
    }

    await expect(test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000)))
      .rejects.toThrow(SimulatedProcessCrash)
    expect(only(test.dispatches)).toMatchObject({ state: 'claimed' })
    expect(only(test.dispatches).preparation).toBeUndefined()
    expect(only(test.admissions)).toMatchObject({ state: 'agent-run', phase: 'accepted' })

    test.restart()
    expect(() => test.operations.validateDurableState(new Set(), test.registry)).not.toThrow()
    expect(await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'protocol' },
    })
    expect(only(test.admissions)).toMatchObject({ state: 'agent-run', phase: 'accepted' })
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

  it('reconciles Host success whose result identifies another Agent Run', async () => {
    const test = harness()
    test.execution.startMode = 'mismatched-result'

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'evidence-conflict' },
    })
    expect(only(test.dispatches)).toMatchObject({
      state: 'reconciliation-required',
      terminalReason: 'evidence-conflict',
      operationSnapshot: { state: 'succeeded' },
    })
    expect(only(test.runs)).toMatchObject({ state: 'reconciliation-required' })
    expect(test.moves).toHaveLength(0)
  })

  it.each([
    ['unavailable', { ok: false, reason: 'unavailable', receipt: { state: 'dispatching' } }],
    ['conflict', {
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'protocol' },
    }],
    ['evidence-conflict', {
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'evidence-conflict' },
    }],
  ] as const)('projects an in-progress move %s outcome onto the Agent operation', async (moveMode, expected) => {
    const test = harness()
    test.moveMode = moveMode

    expect(await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))).toMatchObject(expected)
    expect(only(test.runs)).toMatchObject({ state: 'running' })
    expect(test.moves).toHaveLength(1)
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

  it('accepts an empty pre-provisioning state and rejects retained Agent state without a Registry', async () => {
    const empty = harness()
    expect(empty.operations.validateDurableState(new Set(), undefined)).toEqual({
      intents: [],
      interventions: [],
      runningAgentRuns: [],
      openingInterventionIds: [],
      answerPendingInterventionIds: [],
    })

    const retained = harness()
    retained.execution.prepareMode = 'unavailable'
    await retained.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    expect(() => retained.operations.validateDurableState(new Set(), undefined))
      .toThrow('state exists without the Project Registry')
  })

  it.each([
    ['an Intent stored under another key', (test: Harness) => {
      const retained = only(test.intents)
      test.intents.records.delete(retained.id)
      test.intents.records.set(
        'intent-51515151-5151-4151-8151-515151515151' as SakiControlIntentId,
        retained,
      )
    }, 'Intent id disagrees with its table key'],
    ['a missing Project', (_test: Harness, registry: DevelopmentProjectRegistryRecord) => ({
      ...registry,
      projects: [],
    }), 'inconsistent Project or Agent Profile'],
    ['a missing Agent Profile', (_test: Harness, registry: DevelopmentProjectRegistryRecord) => ({
      ...registry,
      agentProfiles: [],
    }), 'inconsistent Project or Agent Profile'],
    ['an Agent Profile owned by another Project', (_test: Harness, registry: DevelopmentProjectRegistryRecord) => ({
      ...registry,
      agentProfiles: registry.agentProfiles.map(profile => ({
        ...profile,
        projectId: 'project-52525252-5252-4252-8252-525252525252' as SakiDevelopmentProjectId,
      })),
    }), 'inconsistent Project or Agent Profile'],
    ['a missing preallocated child', (test: Harness) => {
      test.assignments.records.clear()
    }, 'lacks a preallocated child'],
    ['a child stored under another key', (test: Harness) => {
      const retained = only(test.assignments)
      test.assignments.records.delete(retained.id)
      test.assignments.records.set(
        'assignment-53535353-5353-4353-8353-535353535353' as SakiWorkAssignmentId,
        retained,
      )
    }, 'Work Assignment id disagrees with its table key'],
  ] as const)('rejects durable state with %s', async (_corruption, corrupt, expected) => {
    const test = harness()
    test.execution.prepareMode = 'unavailable'
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const candidate = corrupt(test, test.registry)
    const registry = candidate === undefined ? test.registry : candidate

    expect(() => test.operations.validateDurableState(new Set(), registry)).toThrow(expected)
  })

  it.each(['reconciliation', 'cancellation'] as const)(
    'rejects a %s terminal write prefix that skips the Assignment',
    async (terminal) => {
      const test = harness()
      const submitted = intent()
      if (terminal === 'reconciliation') {
        test.execution.startMode = 'reconciliation'
        await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
      } else {
        test.execution.startMode = 'unavailable'
        await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
        test.authorityCurrent = false
        await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
      }
      const retainedIntent = only(test.intents)
      test.intents.records.set(retainedIntent.id, agentOperationIntentRecordSchema.parse({
        ...retainedIntent,
        phase: 'dispatching',
        terminalReason: undefined,
      }))
      const assignment = only(test.assignments)
      test.assignments.records.set(assignment.id, workAssignmentRecordSchema.parse({
        ...assignment,
        state: 'assigned',
      }))

      expect(() => test.operations.validateDurableState(new Set(), test.registry))
        .toThrow('inconsistent terminal write prefix')
    },
  )

  it.each([
    ['reconciliation', 'forbidden Assignment state'],
    ['reconciliation', 'running Run without exact Host success'],
    ['cancellation', 'forbidden Assignment state'],
  ] as const)('rejects a %s prefix with a %s', async (terminal, corruption) => {
    const test = harness()
    const submitted = intent()
    if (terminal === 'reconciliation') {
      test.execution.startMode = 'reconciliation'
      await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
    } else {
      test.execution.startMode = 'unavailable'
      await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
      test.authorityCurrent = false
      await test.operations.submit(submitted, actor(), AbortSignal.timeout(5_000))
    }
    const retainedIntent = only(test.intents)
    test.intents.records.set(retainedIntent.id, agentOperationIntentRecordSchema.parse({
      ...retainedIntent,
      phase: 'dispatching',
      terminalReason: undefined,
    }))
    if (corruption === 'running Run without exact Host success') {
      const run = only(test.runs)
      test.runs.records.set(run.id, agentRunRecordSchema.parse({
        ...run,
        state: 'running',
        hostResult: {
          type: 'start-agent-run',
          agentRunId: retainedIntent.hostRequest.run.agentRunId,
          workSessionId: retainedIntent.hostRequest.run.workSessionId,
          sessionId: retainedIntent.hostRequest.run.sessionId,
          inputMessageId: retainedIntent.hostRequest.run.input.id,
        },
      }))
    } else {
      const assignment = only(test.assignments)
      test.assignments.records.set(assignment.id, workAssignmentRecordSchema.parse({
        ...assignment,
        state: terminal === 'reconciliation' ? 'canceled' : 'reconciliation-required',
      }))
    }

    expect(() => test.operations.validateDurableState(new Set(), test.registry))
      .toThrow('inconsistent terminal write prefix')
  })

  it('rejects a canceled Intent with a nonterminal child', async () => {
    const test = harness()
    test.execution.startMode = 'unavailable'
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    test.authorityCurrent = false
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const run = only(test.runs)
    test.runs.records.set(run.id, agentRunRecordSchema.parse({
      ...run,
      state: 'starting',
    }))

    expect(() => test.operations.validateDurableState(new Set(), test.registry))
      .toThrow('canceled Saki Agent operation retains a nonterminal child')
  })

  it('rejects a running Run whose Dispatch does not prove its exact Host result', async () => {
    const test = harness()
    await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
    const retainedIntent = only(test.intents)
    test.intents.records.set(retainedIntent.id, agentOperationIntentRecordSchema.parse({
      ...retainedIntent,
      phase: 'dispatching',
    }))
    const dispatch = only(test.dispatches)
    const snapshot = dispatch.operationSnapshot
    if (snapshot?.state !== 'succeeded') throw new Error('test Dispatch lacks succeeded Host evidence')
    test.dispatches.records.set(dispatch.id, executionDispatchRecordSchema.parse({
      ...dispatch,
      operationSnapshot: {
        ...snapshot,
        result: {
          ...snapshot.result,
          agentRunId: 'agent-run-54545454-5454-4454-8454-545454545454',
        },
      },
    }))

    expect(() => test.operations.validateDurableState(new Set(), test.registry))
      .toThrow('running Saki Agent Run lacks its exact succeeded Dispatch evidence')
  })

  it('rejects an Agent admission whose retained owner does not exist', () => {
    const test = harness()
    test.admissions.records.set(BINDING_ID, foreignAgentWriteAdmission())

    expect(() => test.operations.validateDurableState(new Set(), test.registry))
      .toThrow('write admission has inconsistent ownership')
  })

  it('orders same-time retained Intents deterministically for recovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const test = harness()
      const submitted = [
        intent('intent-56565656-5656-4656-8656-565656565652' as SakiControlIntentId),
        intent('intent-56565656-5656-4656-8656-565656565651' as SakiControlIntentId),
      ]
      for (const candidate of submitted) {
        test.intents.simulateCrashAfterPutWhen(() => true)
        await expect(test.operations.submit(candidate, actor(), new AbortController().signal))
          .rejects.toThrow(SimulatedProcessCrash)
      }

      expect(test.operations.validateDurableState(new Set(), test.registry).intents.map(record => record.id))
        .toEqual(submitted.map(candidate => candidate.intentId).toSorted())
    } finally {
      vi.useRealTimers()
    }
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
  failNextPut: 'before' | 'after' | undefined
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
    if (this.failNextPut === 'before') {
      this.failNextPut = undefined
      throw new Error('injected put failure')
    }
    this.records.set(key, value)
    if (this.failNextPut === 'after') {
      this.failNextPut = undefined
      throw new Error('injected put acknowledgement loss')
    }
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
  prepareMode: 'success' | 'unavailable' | 'source-conflict' | 'terminal-failed' = 'success'
  startMode: 'success' | 'mismatched-result' | 'reconciliation' | 'failed' | 'canceled-authority'
    | 'canceled-source' | 'unavailable' = 'success'
  inspectMode: 'current' | 'reconciliation' | 'failed' | 'canceled-authority' | 'canceled-source' = 'current'
  cancelMode: 'canceled' | 'succeeded' | 'reconciliation' | 'failed' | 'nonterminal' = 'canceled'
  prepareCount = 0
  startCount = 0
  cancelCount = 0
  resumeCount = 0
  cancelError: Error | undefined
  resumeError: Error | undefined
  inspectError: Error | undefined
  projectInspectionError: Error | undefined
  interventionOpeningEvidence: InterventionOpeningEvidence = { kind: 'confirmed', turn: 1, step: 1 }
  afterPrepare: (() => void) | undefined
  beforeAdmission: (() => void) | undefined
  admissionExpectation: ((value: HostOperationAdmissionExpectation) => HostOperationAdmissionExpectation) | undefined
  afterStart: (() => void | Promise<void>) | undefined
  prepareResult: ((value: Extract<HostOperationReceipt<'start-agent-run'>, { readonly ok: true }>) =>
  Extract<HostOperationReceipt<'start-agent-run'>, { readonly ok: true }>) | undefined
  request: StartAgentRunHostOperationRequest | undefined
  private admission: HostOperationAdmissionSource | undefined
  private preparation: HostOperationPreparation<'start-agent-run'> | undefined
  private snapshot: HostOperationSnapshot<'start-agent-run'> | undefined
  private readonly acceptance = new TestAcceptance('agent-operation-test')

  constructor(private readonly project: () => InspectProjectResult) { super(new Context()) }

  beginNextOperation(): void {
    this.request = undefined
    this.admission = undefined
    this.preparation = undefined
    this.snapshot = undefined
  }

  async inspectProjectSelection(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
    return { ok: false, reason: 'unavailable' }
  }

  async inspectProjectCommit(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
    return { ok: false, reason: 'unavailable' }
  }

  async inspectProject(): Promise<InspectProjectResult> {
    if (this.projectInspectionError !== undefined) throw this.projectInspectionError
    return this.project()
  }
  async inspectInterventionOpening(): Promise<InterventionOpeningEvidence> {
    return this.interventionOpeningEvidence
  }
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
    if (this.prepareMode === 'source-conflict') return { ok: false, reason: 'source-conflict' }
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
    if (this.prepareMode === 'terminal-failed' && this.snapshot.state === 'prepared') {
      this.snapshot = {
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        state: 'failed',
        updatedAt: 2,
        completedAt: 2,
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      }
    }
    const afterPrepare = this.afterPrepare
    this.afterPrepare = undefined
    afterPrepare?.()
    const result = {
      ok: true,
      preparation: this.preparation,
      snapshot: this.snapshot,
      acceptance: this.acceptance,
    } as const
    return this.prepareResult?.(result) ?? result
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
    const beforeAdmission = this.beforeAdmission
    this.beforeAdmission = undefined
    beforeAdmission?.()
    const expectation = {
      bindingId: request.expected.binding.id,
      bindingRevision: request.expected.binding.revision,
      preparation,
      source: request.source,
    }
    const decision = await admission(this.admissionExpectation?.(expectation) ?? expectation, signal)
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
      : this.startMode === 'failed'
        ? {
          ...common,
          state: 'failed',
          completedAt: 3,
          failure: { reason: 'unsupported-state' },
          effect: 'none',
        }
        : this.startMode === 'canceled-authority' || this.startMode === 'canceled-source'
          ? {
            ...common,
            state: 'canceled',
            completedAt: 3,
            reason: this.startMode === 'canceled-authority' ? 'authority-revoked' : 'source-canceled',
            effect: 'none',
          }
          : {
            ...common,
            state: 'succeeded',
            completedAt: 3,
            result: {
              type: 'start-agent-run',
              agentRunId: this.startMode === 'mismatched-result'
                ? 'agent-run-57575757-5757-4757-8757-575757575757' as SakiAgentRunId
                : request.run.agentRunId,
              workSessionId: request.run.workSessionId,
              sessionId: request.run.sessionId,
              inputMessageId: request.run.input.id,
            },
          }
    const afterStart = this.afterStart
    this.afterStart = undefined
    await afterStart?.()
    return { ok: true, snapshot: this.snapshot } as HostOperationStartResult<K>
  }

  async inspectOperation<K extends HostOperationKind>(): Promise<HostOperationSnapshot<K>> {
    if (this.inspectError !== undefined) throw this.inspectError
    const current = this.requireSnapshot()
    if (this.inspectMode === 'current') return current as HostOperationSnapshot<K>
    const common = {
      operation: current.operation,
      revision: current.revision + 1,
      source: current.source,
      requestFingerprint: current.requestFingerprint,
      bindingId: current.bindingId,
      bindingRevision: current.bindingRevision,
      preparedAt: current.preparedAt,
      updatedAt: 3,
    }
    this.snapshot = this.inspectMode === 'reconciliation'
      ? {
        ...common,
        state: 'reconciliation-required',
        admission: { kind: 'accepted', revision: 2, acceptedAt: 2 },
        observedAt: 3,
        reason: 'effect-unknown',
      }
      : this.inspectMode === 'failed'
        ? {
          ...common,
          state: 'failed',
          admission: current.admission,
          completedAt: 3,
          failure: { reason: 'unsupported-state' },
          effect: 'none',
        }
        : {
          ...common,
          state: 'canceled',
          admission: current.admission,
          completedAt: 3,
          reason: this.inspectMode === 'canceled-authority' ? 'authority-revoked' : 'source-canceled',
          effect: 'none',
        }
    return this.snapshot as HostOperationSnapshot<K>
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
    if (this.cancelMode === 'nonterminal') return current as HostOperationSnapshot<K>
    const common = {
      operation: current.operation,
      revision: current.revision + 1,
      source: current.source,
      requestFingerprint: current.requestFingerprint,
      bindingId: current.bindingId,
      bindingRevision: current.bindingRevision,
      preparedAt: current.preparedAt,
      updatedAt: 4,
    }
    if (this.cancelMode === 'succeeded') {
      const request = this.requireRequest()
      this.snapshot = {
        ...common,
        state: 'succeeded',
        admission: { kind: 'accepted', revision: 2, acceptedAt: 2 },
        completedAt: 4,
        result: {
          type: 'start-agent-run',
          agentRunId: request.run.agentRunId,
          workSessionId: request.run.workSessionId,
          sessionId: request.run.sessionId,
          inputMessageId: request.run.input.id,
        },
      }
      return this.snapshot as HostOperationSnapshot<K>
    }
    if (this.cancelMode === 'reconciliation') {
      this.snapshot = {
        ...common,
        state: 'reconciliation-required',
        admission: { kind: 'accepted', revision: 2, acceptedAt: 2 },
        observedAt: 4,
        reason: 'effect-unknown',
      }
      return this.snapshot as HostOperationSnapshot<K>
    }
    this.snapshot = this.cancelMode === 'failed' ? {
      ...common,
      state: 'failed',
      admission: current.admission,
      completedAt: 4,
      failure: { reason: 'unsupported-state' },
      effect: 'none',
    } : {
      ...current,
      ...common,
      state: 'canceled',
      admission: current.admission,
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
  readonly interventions: MemoryTable<SakiInterventionRequestId, InterventionRequestRecord>
  readonly admissions: MemoryTable<SakiResourceBindingId, BindingWriteAdmissionRecord>
  readonly execution: FakeAgentExecution
  readonly registry: DevelopmentProjectRegistryRecord
  readonly eligibility: EligibilityState
  readonly moves: MoveWorkItemIntent[]
  readonly resolvedModelRoutes: { readonly provider: string; readonly model: string }[]
  restart(): void
  attachDuplicateGitHub(): void
  detachGitHub(): void
  moveMode: 'success' | 'unavailable' | 'conflict' | 'reconciliation' | 'evidence-conflict'
  authorityCurrent: boolean
  bindingCurrent: boolean
  bindingProjectRevision: number
  modelRouteAvailable: boolean
  afterResolveModelRoute: (() => void) | undefined
  issueBody: string
}

interface EligibilityState {
  registry: DevelopmentProjectRegistryRecord
  mutationContext: GitHubWorkItemMutationContextResult
  projectInspection: InspectProjectResult
  issueDetail: GitHubIssueDetailFact
  branchSafety: GitHubBranchSafetyFact
  githubReadFailure: 'issue-detail' | 'branch-safety' | undefined
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
  const mutationContext: GitHubWorkItemMutationContextResult = {
    ok: true,
    context: {
      synchronizationRevision: 1,
      mappingRevision: 1,
      checkpointObservedAt: item.updatedAt,
      configuration: active.configuration,
      confirmedBoard: board,
    },
  }
  const observationResult = SAKI_GIT_CHANGES_PROJECTION_FIXTURES.clean.result
  if (!observationResult.ok) throw new Error('clean Git fixture is unavailable')
  const projectInspection: InspectProjectResult = {
    ok: true,
    observation: observationResult.observation,
    preEffectBaseline: baseline,
  }
  const issueBody = [
    '# Intended outcome',
    'Ship the vertical slice.',
    '# Acceptance criteria',
    '- Delivers the exact input once',
    '- Moves to in-progress after the Run exists',
    '# Blocked by',
    'None',
  ].join('\n')
  const eligibility: EligibilityState = {
    registry,
    mutationContext,
    projectInspection,
    issueDetail: {
      id: item.source.issueId,
      repositoryId: item.source.repositoryId,
      repositoryDatabaseId: active.configuration.repositoryDatabaseId,
      number: item.issueNumber,
      state: item.issueState,
      title: item.title,
      url: item.url,
      updatedAt: item.updatedAt,
      body: issueBody,
    },
    branchSafety: { kind: 'safe', branchExists: true, observedAt: item.updatedAt },
    githubReadFailure: undefined,
  }
  const execution = new FakeAgentExecution(() => eligibility.projectInspection)
  const intents = new MemoryTable<SakiControlIntentId, AgentOperationIntentRecord>()
  const assignments = new MemoryTable<SakiWorkAssignmentId, WorkAssignmentRecord>()
  const sessions = new MemoryTable<SakiWorkSessionId, WorkSessionRecord>()
  const runs = new MemoryTable<SakiAgentRunId, AgentRunRecord>()
  const dispatches = new MemoryTable<SakiExecutionDispatchId, ExecutionDispatchRecord>()
  const interventions = new MemoryTable<SakiInterventionRequestId, InterventionRequestRecord>()
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
  const state: Pick<Harness, 'moveMode' | 'authorityCurrent' | 'bindingCurrent' | 'bindingProjectRevision'
  | 'modelRouteAvailable' | 'afterResolveModelRoute'> = {
    moveMode: 'success',
    authorityCurrent: true,
    bindingCurrent: true,
    bindingProjectRevision: PROJECT.revision,
    modelRouteAvailable: true,
    afterResolveModelRoute: undefined,
  }
  const githubReader = {
    read: async (request: GitHubReadRequest) => {
      if (eligibility.githubReadFailure === request.kind) throw new Error('test GitHub read is unavailable')
      return request.kind === 'issue-detail' ? eligibility.issueDetail : eligibility.branchSafety
    },
  } as never
  let detachGitHubReader = () => {}
  const createOperations = (): AgentOperations => {
    const candidate = new AgentOperations({
      intentTable: intents,
      assignmentTable: assignments,
      workSessionTable: sessions,
      agentRunTable: runs,
      dispatchTable: dispatches,
      interventionTable: interventions,
      admissionTable: admissions,
      execution,
      projects: {
        registry: () => eligibility.registry,
        currentActiveBinding: () => state.bindingCurrent ? ({
          registryRevision: eligibility.registry.revision,
          projectId: PROJECT_ID,
          projectRevision: state.bindingProjectRevision,
          binding: activeHostProjectBinding(resource),
        }) : 'binding-unavailable',
      } as never,
      mutationContext: () => eligibility.mutationContext,
      authorityCurrent: () => state.authorityCurrent,
      validateActorReference: () => {},
      resolveModelRoute: async (route) => {
        resolvedModelRoutes.push(route)
        if (!state.modelRouteAvailable) throw new Error('test Model Route is unavailable')
        const afterResolveModelRoute = state.afterResolveModelRoute
        state.afterResolveModelRoute = undefined
        afterResolveModelRoute?.()
      },
      moveWorkItem: async (move): Promise<SakiWorkItemIntentReceipt<'move-work-item'>> => {
        moves.push(move)
        if (state.moveMode === 'unavailable') return { ok: false, reason: 'unavailable' }
        if (state.moveMode === 'conflict') return { ok: false, reason: 'conflict' }
        if (state.moveMode === 'reconciliation' || state.moveMode === 'evidence-conflict') {
          return {
            ok: false,
            reason: 'reconciliation-required',
            receipt: {
              id: move.intentId.replace(/^intent-/u, 'receipt-') as never,
              intentId: move.intentId,
              type: 'move-work-item',
              projectId: move.projectId,
              state: 'reconciliation-required',
              reason: state.moveMode === 'evidence-conflict' ? 'evidence-conflict' : 'effect-unknown',
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
    detachGitHubReader = candidate.attachGitHub(githubReader)
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
    interventions,
    admissions,
    execution,
    get registry() { return eligibility.registry },
    eligibility,
    moves,
    resolvedModelRoutes,
    restart() { operations = createOperations() },
    attachDuplicateGitHub() { operations.attachGitHub(githubReader) },
    detachGitHub() { detachGitHubReader() },
    get moveMode() { return state.moveMode },
    set moveMode(value) { state.moveMode = value },
    get authorityCurrent() { return state.authorityCurrent },
    set authorityCurrent(value) { state.authorityCurrent = value },
    get bindingCurrent() { return state.bindingCurrent },
    set bindingCurrent(value) { state.bindingCurrent = value },
    get bindingProjectRevision() { return state.bindingProjectRevision },
    set bindingProjectRevision(value) { state.bindingProjectRevision = value },
    get modelRouteAvailable() { return state.modelRouteAvailable },
    set modelRouteAvailable(value) { state.modelRouteAvailable = value },
    get afterResolveModelRoute() { return state.afterResolveModelRoute },
    set afterResolveModelRoute(value) { state.afterResolveModelRoute = value },
    get issueBody() { return eligibility.issueDetail.body },
    set issueBody(value) { eligibility.issueDetail = { ...eligibility.issueDetail, body: value } },
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

function replaceBoardItems(test: Harness, items: readonly SakiBoardWorkItemProjection[]): void {
  const mutation = test.eligibility.mutationContext
  if (!mutation.ok) throw new Error('test Board mutation context is unavailable')
  test.eligibility.mutationContext = {
    ...mutation,
    context: {
      ...mutation.context,
      confirmedBoard: { ...mutation.context.confirmedBoard, items },
    },
  }
}

function patchBoardItem(test: Harness, patch: Partial<SakiBoardWorkItemProjection>): void {
  const mutation = test.eligibility.mutationContext
  if (!mutation.ok) throw new Error('test Board mutation context is unavailable')
  const item = mutation.context.confirmedBoard.items[0]
  if (item === undefined) throw new Error('test Board Work Item is unavailable')
  replaceBoardItems(test, [{ ...item, ...patch }])
}

function patchIssueDetail(test: Harness, patch: Partial<GitHubIssueDetailFact>): void {
  test.eligibility.issueDetail = { ...test.eligibility.issueDetail, ...patch }
}

function staleRemote() {
  return {
    ok: false,
    reason: 'conflict',
    receipt: { state: 'conflict', reason: 'stale-remote' },
  } as const
}

function updateProjectInspection(
  test: Harness,
  update: (current: Extract<InspectProjectResult, { readonly ok: true }>) => InspectProjectResult,
): void {
  const current = test.eligibility.projectInspection
  if (!current.ok) throw new Error('test Project inspection is unavailable')
  test.eligibility.projectInspection = update(current)
}

function manualWriteAdmission(): Extract<
  BindingWriteAdmissionRecord,
  { readonly state: 'manual-host-operation'; readonly phase: 'reserved' }
> {
  return bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 1,
    state: 'manual-host-operation',
    phase: 'reserved',
    bindingRevision: 0,
    source: {
      kind: 'control-intent',
      intentId: 'intent-41414141-4141-4141-8141-414141414141',
      intentRevision: 0,
      payloadDigest: '1'.repeat(64),
    },
    action: 'project-changes:stage',
    reservedAt: 1,
    updatedAt: 1,
  }) as Extract<
    BindingWriteAdmissionRecord,
    { readonly state: 'manual-host-operation'; readonly phase: 'reserved' }
  >
}

function foreignAgentWriteAdmission(): Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run' }> {
  const candidate = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 1,
    state: 'agent-run',
    phase: 'reserved',
    bindingRevision: 0,
    originIntentId: 'intent-49494949-4949-4949-8949-494949494949',
    agentRunId: 'agent-run-50505050-5050-4050-8050-505050505050',
    payloadDigest: '5'.repeat(64),
    reservedAt: 1,
    updatedAt: 1,
  })
  if (candidate.state !== 'agent-run') throw new Error('test admission is not owned by an Agent Run')
  return candidate
}

function expectSchemaIssue(
  result: { readonly success: boolean; readonly error?: { readonly issues: readonly { readonly message: string }[] } },
  message: string,
): void {
  expect(result.success ? [] : result.error?.issues.map(issue => issue.message)).toContain(message)
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

function claimedDispatchForCorruption(
  dispatch: ExecutionDispatchRecord,
  claimId: string,
): ExecutionDispatchRecord {
  const now = Date.now()
  return executionDispatchRecordSchema.parse({
    ...dispatch,
    state: 'claimed',
    claim: {
      id: claimId,
      executorHostId: HOST_ID,
      fencingToken: dispatch.latestFencingToken,
      issuedAt: now,
      expiresAt: now + 30_000,
    },
    updatedAt: Math.max(dispatch.updatedAt, now),
  })
}

async function createOpenIntervention(
  test: Harness,
  toolCallId: string,
  finalize?: true,
): Promise<{
  readonly requested: { readonly ok: true; readonly interventionId: SakiInterventionRequestId }
  readonly open: Extract<InterventionRequestRecord, { readonly state: 'open' }>
}>
async function createOpenIntervention(
  test: Harness,
  toolCallId: string,
  finalize: false,
): Promise<{
  readonly requested: { readonly ok: true; readonly interventionId: SakiInterventionRequestId }
  readonly open: Extract<InterventionRequestRecord, { readonly state: 'opening' }>
}>
async function createOpenIntervention(
  test: Harness,
  toolCallId: string,
  finalize = true,
): Promise<{
  readonly requested: { readonly ok: true; readonly interventionId: SakiInterventionRequestId }
  readonly open: InterventionRequestRecord
}> {
  const started = await test.operations.submit(intent(), actor(), AbortSignal.timeout(5_000))
  if (!started.ok) throw new Error('test Agent Run was not started')
  const run = only(test.runs)
  const requested = await test.operations.requestIntervention({
    sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
    toolCallId: CallId(toolCallId),
    prompt: 'Which exact path should this Agent Run take?',
  }, AbortSignal.timeout(5_000))
  if (!requested.ok) throw new Error('test Intervention was not created')
  if (finalize) {
    const outcome = await test.operations.finalizeInterventionOpening(
      requested.interventionId,
      AbortSignal.timeout(5_000),
    )
    if (outcome !== 'open') throw new Error('test Intervention did not open')
  }
  const open = interventionRequestRecordSchema.parse(test.interventions.get(requested.interventionId))
  if (finalize ? open.state !== 'open' : open.state !== 'opening') {
    throw new Error('test Intervention has an unexpected opening state')
  }
  return { requested, open }
}

function interventionAnswer(
  intervention: Extract<InterventionRequestRecord, { readonly state: 'open' }>,
  intentId: string,
  text: string,
): AnswerInterventionIntent {
  return {
    type: 'answer-intervention',
    intentId: intentId as SakiControlIntentId,
    interventionId: intervention.id,
    expectedInterventionRevision: intervention.revision,
    answer: { kind: 'text', text },
  }
}

async function createAnsweredIntervention(
  test: Harness,
  toolCallId: string,
): Promise<Extract<InterventionRequestRecord, { readonly state: 'answered' }>> {
  const { open } = await createOpenIntervention(test, toolCallId)
  test.execution.beginNextOperation()
  test.execution.prepareMode = 'unavailable'
  const result = await test.operations.answerIntervention(
    interventionAnswer(open, 'intent-33333333-3333-4333-8333-333333333333', 'Keep this answer pending.'),
    actor(),
    AbortSignal.timeout(5_000),
  )
  if (result.ok || result.reason !== 'unavailable') throw new Error('test answer did not remain pending')
  const answered = interventionRequestRecordSchema.parse(test.interventions.get(open.id))
  if (answered.state !== 'answered') throw new Error('test Intervention is not answered')
  return answered
}

async function createResolvedIntervention(
  test: Harness,
  toolCallId: string,
  answerIntentId = 'intent-34343434-3434-4434-8434-343434343434' as SakiControlIntentId,
): Promise<Extract<InterventionRequestRecord, { readonly state: 'resolved' }>> {
  const { open } = await createOpenIntervention(test, toolCallId)
  test.execution.beginNextOperation()
  const result = await test.operations.answerIntervention(
    interventionAnswer(open, answerIntentId, 'Resolve this answer.'),
    actor(),
    AbortSignal.timeout(5_000),
  )
  if (!result.ok) throw new Error('test answer did not resolve')
  const resolved = interventionRequestRecordSchema.parse(test.interventions.get(open.id))
  if (resolved.state !== 'resolved') throw new Error('test Intervention is not resolved')
  return resolved
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
