import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { freezeMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session } from '@deepseek-ai/dsh-session'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  computeStartAgentRunPayloadDigest,
  type ActiveHostProjectBinding,
  type HostOperationAdmissionSource,
  type SakiAgentProfileId,
  type SakiAgentRunId,
  type SakiControlIntentId,
  type SakiExecutionDispatchId,
  type SakiGrantId,
  type SakiHostId,
  type SakiInstallationId,
  type SakiInterventionRequestId,
  type SakiPrincipalId,
  type SakiResourceBindingId,
  type SakiStorageGenerationId,
  type SakiWorkSessionId,
  type StartAgentRunHostOperationRequest,
  type StartAgentRunInputMessage,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalSakiHostExecution, {
  type Config,
  type LocalHostOperationRecord,
  sakiHostExecutionDomainSpec,
  sakiHostExecutionV2DomainSpec,
} from '../src/index.ts'
import { disposeLocalAgentRuns, waitForInputRecord } from '../src/agent-run.ts'
import { GitCommandError, type GitRunner } from '../src/git-runner.ts'

const run = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
const BINDING_ID = 'binding-11111111-1111-4111-8111-111111111111' as SakiResourceBindingId
const WORKSPACE_ID = WorkspaceId('workspace-agent-run')
const DISPATCH_ID = 'dispatch-22222222-2222-4222-8222-222222222222' as SakiExecutionDispatchId
const AGENT_RUN_ID = 'agent-run-33333333-3333-4333-8333-333333333333' as SakiAgentRunId
const WORK_SESSION_ID = 'work-session-44444444-4444-4444-8444-444444444444' as SakiWorkSessionId
const AGENT_PROFILE_ID = 'agent-profile-55555555-5555-4555-8555-555555555555' as SakiAgentProfileId
const SESSION_ID = 'session-66666666-6666-4666-8666-666666666666' as StartAgentRunHostOperationRequest['run']['sessionId']
const MESSAGE_ID = '77777777-7777-4777-8777-777777777777' as StartAgentRunInputMessage['id']
const ANSWER_DISPATCH_ID = 'dispatch-88888888-8888-4888-8888-888888888888' as SakiExecutionDispatchId
const ANSWER_MESSAGE_ID = '99999999-9999-4999-8999-999999999999' as StartAgentRunInputMessage['id']
const INTERVENTION_ID = 'intervention-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as SakiInterventionRequestId
const ANSWER_INTENT_ID = 'intent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SakiControlIntentId
const INSTALLATION_ID = 'installation-cccccccc-cccc-4ccc-8ccc-cccccccccccc' as SakiInstallationId
const STORAGE_GENERATION_ID =
  'storage-generation-dddddddd-dddd-4ddd-8ddd-dddddddddddd' as SakiStorageGenerationId
const PRINCIPAL_ID = 'principal-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as SakiPrincipalId
const GRANT_ID = 'grant-ffffffff-ffff-4fff-8fff-ffffffffffff' as SakiGrantId

const CONFIG: Omit<Required<Config>, 'pushCredentialHelper'> = {
  gitCommandTimeoutMs: 10_000,
  gitTerminationGraceMs: 100,
  maxGitStdoutBytes: 1024 * 1024,
  maxGitStderrBytes: 64 * 1024,
  inventoryMaxEntries: 10_000,
  inventoryMaxPathBytes: 1024 * 1024,
  inventoryMaxGitOutputBytes: 4 * 1024 * 1024,
  inventoryMaxFileBytes: 1024 * 1024,
  inventoryMaxTotalFileBytes: 8 * 1024 * 1024,
  inventoryMaxCaptureMs: 10_000,
  baselineMaxEntries: 1_000,
  baselineMaxPathBytes: 1024 * 1024,
  baselineMaxGitOutputBytes: 4 * 1024 * 1024,
  baselineMaxFileBytes: 1024 * 1024,
  baselineMaxTotalFileBytes: 4 * 1024 * 1024,
  baselineMaxCaptureMs: 10_000,
  operationMaxIndexBytes: 8 * 1024 * 1024,
  operationMaxReflogBytes: 1024 * 1024,
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('LocalSakiHostExecution StartAgentRun', () => {
  it('starts one exact preallocated Agent Run without exposing its wake message to the model', async () => {
    const harness = await agentRunHarness([stopResponse('done')])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(7), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const started = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'start-agent-run',
          agentRunId: AGENT_RUN_ID,
          workSessionId: WORK_SESSION_ID,
          sessionId: SESSION_ID,
          inputMessageId: MESSAGE_ID,
        },
      },
    })
    const agent = harness.context.agents.get(SESSION_ID)
    expect(agent).toBeDefined()
    if (agent === undefined) return
    await agent.whenIdle()
    expect(harness.adapter.requests).toHaveLength(1)
    expect(harness.adapter.requests[0]?.messages.filter(message => message.role === 'user')).toEqual([
      expect.objectContaining({ id: MESSAGE_ID, content: [{ type: 'text', text: 'Implement the issue exactly once.' }] }),
    ])
    expect(agent.session.events.filter(event => event.type === 'user/message').map(event => event.data.id))
      .toEqual([MESSAGE_ID])
  }, 30_000)

  it('delivers one attributed answer through a second Dispatch to the same Run and Session', async () => {
    const harness = await agentRunHarness([stopResponse('initial done'), stopResponse('answer received')])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const initial = await startAgentRunRequest(harness.execution, binding, signal)
    const preparedInitial = await harness.execution.prepareOperation(initial, accepted(7), signal)
    expect(preparedInitial.ok).toBe(true)
    if (!preparedInitial.ok) return
    await harness.execution.startOperation(preparedInitial.preparation.operation, preparedInitial.acceptance, signal)
    const agent = harness.context.agents.get(SESSION_ID)
    expect(agent).toBeDefined()
    if (agent === undefined) return
    await agent.whenIdle()

    const input = interventionAnswerInput()
    const answer = interventionAnswerRequest(initial, input)
    const preparedAnswer = await harness.execution.prepareOperation(answer, accepted(8), signal)
    expect(preparedAnswer.ok).toBe(true)
    if (!preparedAnswer.ok) return

    const started = await harness.execution.startOperation(
      preparedAnswer.preparation.operation,
      preparedAnswer.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'start-agent-run',
          agentRunId: AGENT_RUN_ID,
          workSessionId: WORK_SESSION_ID,
          sessionId: SESSION_ID,
          inputMessageId: ANSWER_MESSAGE_ID,
        },
      },
    })
    if (!started.ok || started.snapshot.state !== 'succeeded') return
    const currentRecord = {
      schemaVersion: 4 as const,
      request: answer,
      preparationRevision: preparedAnswer.preparation.preparationRevision,
      snapshot: started.snapshot,
      effectPlan: { kind: 'agent-run' as const, publication: 'applied-recorded' as const, result: started.snapshot.result },
    }
    expect(sakiHostExecutionDomainSpec.tables.operations.valueSchema.safeParse(currentRecord).success).toBe(true)
    expect(sakiHostExecutionV2DomainSpec.tables.operations.valueSchema.safeParse({
      ...currentRecord,
      schemaVersion: 2,
    }).success).toBe(false)
    expect(harness.context.agents.get(SESSION_ID)).toBe(agent)
    await agent.whenIdle()
    expect(harness.adapter.requests).toHaveLength(2)
    expect(harness.adapter.requests[1]?.messages.filter(message => message.role === 'user').map(message => message.id))
      .toEqual([MESSAGE_ID, ANSWER_MESSAGE_ID])
    expect(harness.adapter.requests[1]?.messages.find(message => message.id === ANSWER_MESSAGE_ID)).toEqual(input)
    expect(agent.session.events.filter(event => event.type === 'user/message').map(event => event.data.id))
      .toEqual([MESSAGE_ID, ANSWER_MESSAGE_ID])
    expect(agent.session.events.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data.inserted)
      .filter(message => message.id === ANSWER_MESSAGE_ID)).toEqual([input])
  }, 90_000)

  it('delivers an answer after restoring the owning Run without creating another Session', async () => {
    const { operation, request: initial, restarted, signal } = await restartedSucceededAgentRun([
      stopResponse('answer after restart'),
    ])
    await restarted.execution.resumeAgentRun(operation, initial, signal)
    const restored = restarted.context.agents.get(SESSION_ID)
    expect(restored).toBeDefined()
    if (restored === undefined) return
    const input = interventionAnswerInput()
    const answer = interventionAnswerRequest(initial, input)
    const prepared = await restarted.execution.prepareOperation(answer, accepted(9), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const started = await restarted.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(restarted.context.agents.get(SESSION_ID)).toBe(restored)
    await restored.whenIdle()
    expect(restarted.adapter.requests).toHaveLength(1)
    expect(restarted.adapter.requests[0]?.messages.filter(message => message.role === 'user').map(message => message.id))
      .toEqual([MESSAGE_ID, ANSWER_MESSAGE_ID])
    expect(restarted.adapter.requests[0]?.messages.find(message => message.id === ANSWER_MESSAGE_ID)).toEqual(input)
  }, 90_000)

  it('fails without an Agent effect when the frozen repository changes before start', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(17), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    await writeFile(join(harness.repository, 'tracked.txt'), 'changed after prepare\n')

    const started = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'observation-stale' },
        effect: 'none',
      },
    })
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    expect(harness.adapter.requests).toHaveLength(0)
    await expect(harness.context.sessionPersistence.listSnapshots(signal)).resolves.toEqual([])
  }, 30_000)

  it('keeps the Agent Run retryable when the frozen world is temporarily unavailable', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(29), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const git = replaceGitRunner(harness.execution, new GitCommandError('spawn-failure'))

    const started = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    expect(harness.adapter.requests).toHaveLength(0)
    git.restore()
  }, 30_000)

  it('rechecks the frozen repository after Agent creation before sending exact input', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(20), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const create = harness.context.agents.create.bind(harness.context.agents)
    vi.spyOn(harness.context.agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      await writeFile(join(harness.repository, 'tracked.txt'), 'changed while acquiring Agent\n')
      return handle
    })

    const started = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: { state: 'failed', failure: { reason: 'observation-stale' }, effect: 'none' },
    })
    expect(harness.adapter.requests).toHaveLength(0)
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    const snapshots = await harness.context.sessionPersistence.listSnapshots(signal)
    const durable = snapshots.some(snapshot => snapshot.header.id === SESSION_ID)
      ? await harness.context.sessionPersistence.readFrom(SESSION_ID, 0, signal)
      : undefined
    expect(durable?.events.some(event => event.type === 'user/message' && event.data.id === MESSAGE_ID) ?? false)
      .toBe(false)
  }, 30_000)

  it('does not publish stale-world failure until the acquired Agent is disposed', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(23), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const create = harness.context.agents.create.bind(harness.context.agents)
    let acquiredHandle: Awaited<ReturnType<typeof create>> | undefined
    vi.spyOn(harness.context.agents, 'create').mockImplementation(async (options) => {
      const handle = acquiredHandle = await create(options)
      vi.spyOn(handle, 'dispose').mockRejectedValueOnce(new Error('stale Agent Handle drain failed'))
      await writeFile(join(harness.repository, 'tracked.txt'), 'changed before failed stale drain\n')
      return handle
    })

    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('stale Agent Handle drain failed')

    expect(await harness.execution.inspectOperation(prepared.preparation.operation, signal))
      .toMatchObject({ state: 'publishing' })
    const handles = (harness.execution as unknown as {
      liveAgentRuns: Map<typeof SESSION_ID, Awaited<ReturnType<typeof create>>>
    }).liveAgentRuns
    expect(handles.get(SESSION_ID)).toBe(acquiredHandle)
    expect(harness.context.agents.get(SESSION_ID)).toBe(acquiredHandle?.agent)

    const replayed = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(replayed).toMatchObject({
      ok: true,
      snapshot: { state: 'failed', failure: { reason: 'observation-stale' }, effect: 'none' },
    })
    expect(handles.has(SESSION_ID)).toBe(false)
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    expect(harness.adapter.requests).toHaveLength(0)
  }, 30_000)

  it('rechecks a stale repository after restarting an attempting operation with no Session evidence', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(18), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const persistence = operationPersistence(harness.execution)
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'agent-run'
        && record.effectPlan.publication === 'attempting') {
        throw new Error('lost Agent Run attempt acknowledgement')
      }
    })
    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('lost Agent Run attempt acknowledgement')
    persistence.restore()
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    await writeFile(join(harness.repository, 'tracked.txt'), 'changed before restart\n')

    const restarted = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(restarted).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'observation-stale' },
        effect: 'none',
      },
    })
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    expect(harness.adapter.requests).toHaveLength(0)
    await expect(harness.context.sessionPersistence.listSnapshots(signal)).resolves.toEqual([])
  }, 30_000)

  it('resumes one pending exact input after its durable flush acknowledgement is lost', async () => {
    const harness = await agentRunHarness([stopResponse('done')])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(8), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const flush = failNextSessionFlush(harness.context, SESSION_ID)

    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('lost durable Agent Run inbox acknowledgement')
    flush.restore()
    expect(flush.didFail()).toBe(true)
    expect(harness.adapter.requests).toHaveLength(0)

    const replayed = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(replayed).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    const agent = harness.context.agents.get(SESSION_ID)
    expect(agent).toBeDefined()
    if (agent === undefined) return
    await agent.whenIdle()
    expect(harness.adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'user/message' && event.data.id === MESSAGE_ID))
      .toHaveLength(1)
    const exactInsertions = agent.session.events.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data.inserted)
      .filter(message => message.id === MESSAGE_ID)
    expect(exactInsertions).toEqual([request.run.input])
  }, 30_000)

  it('observes an abort that races with installation of the input-record listener', async () => {
    const controller = new AbortController()
    const signal = controller.signal
    const abortReason = new Error('abort raced with Agent Run input listener installation')
    const originalAddEventListener = signal.addEventListener.bind(signal)
    Object.defineProperty(signal, 'addEventListener', {
      configurable: true,
      value: (type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): void => {
        if (type === 'abort') controller.abort(abortReason)
        originalAddEventListener(type, listener, options)
      },
    })
    const agent = {
      session: { events: [] },
      ctx: { on: () => () => {} },
    } as unknown as Agent
    const expected = freezeMessage({
      id: MESSAGE_ID,
      role: 'user',
      content: [{ type: 'text', text: 'Lifecycle race input.' }],
      source: {
        kind: 'saki-agent-run',
        dispatchId: DISPATCH_ID,
        agentRunId: AGENT_RUN_ID,
        workSessionId: WORK_SESSION_ID,
      },
    }) as StartAgentRunInputMessage

    let wakeCount = 0
    await expect(waitForInputRecord(agent, expected, signal, () => { wakeCount += 1 })).rejects.toBe(abortReason)
    expect(wakeCount).toBe(0)
  })

  it('does not wake an Agent whose exact input is already model-visible', async () => {
    const expected = agentRunInput('Already recorded input.')
    const agent = {
      session: { events: [{ type: 'user/message', data: expected }] },
      ctx: { on: () => () => {} },
    } as unknown as Agent
    let wakeCount = 0

    await waitForInputRecord(agent, expected, new AbortController().signal, () => { wakeCount += 1 })

    expect(wakeCount).toBe(0)
  })

  it('rejects a conflicting same-id input recorded after wake', async () => {
    const expected = agentRunInput('Expected input.')
    const conflicting = freezeMessage({
      ...expected,
      content: [{ type: 'text', text: 'Conflicting input.' }],
    }) as StartAgentRunInputMessage
    let sessionListener: ((session: unknown, event: { readonly type: 'user/message'; readonly data: StartAgentRunInputMessage }) => void)
      | undefined
    const agent = {
      session: { events: [] },
      ctx: {
        on: (event: string, listener: unknown) => {
          if (event === 'session/event') {
            sessionListener = listener as typeof sessionListener
          }
          return () => {}
        },
      },
    } as unknown as Agent

    await expect(waitForInputRecord(agent, expected, new AbortController().signal, () => {
      sessionListener?.(agent.session, { type: 'user/message', data: conflicting })
    })).rejects.toThrow('input identity has conflicting recorded evidence')
  })

  it('rejects a wake that becomes idle before recording its exact input', async () => {
    const expected = agentRunInput('Input that must be recorded.')
    let statusListener: ((event: { readonly agent: Agent; readonly status: 'idle' }) => void) | undefined
    const agent = {
      session: { events: [] },
      ctx: {
        on: (event: string, listener: unknown) => {
          if (event === 'agent/status') statusListener = listener as typeof statusListener
          return () => {}
        },
      },
    } as unknown as Agent

    await expect(waitForInputRecord(agent, expected, new AbortController().signal, () => {
      statusListener?.({ agent, status: 'idle' })
    })).rejects.toThrow('became idle before recording its exact input')
  })

  it('attempts every Agent Handle disposal before aggregating teardown failures', async () => {
    const firstFailure = new Error('first Agent Handle disposal failed')
    const secondFailure = new Error('second Agent Handle disposal failed')
    const disposed: number[] = []
    const handles = new Map([
      [SESSION_ID, { dispose: async () => { disposed.push(1); throw firstFailure } }],
      ['session-99999999-9999-4999-8999-999999999999' as typeof SESSION_ID,
        { dispose: async () => { disposed.push(2); throw secondFailure } }],
    ]) as unknown as Map<typeof SESSION_ID, Parameters<typeof disposeLocalAgentRuns>[0] extends Map<typeof SESSION_ID, infer H> ? H : never>

    const failure = await disposeLocalAgentRuns(handles).catch((error: unknown) => error)

    expect(disposed).toEqual([1, 2])
    expect(handles.size).toBe(0)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([firstFailure, secondFailure])
  })

  it('does not confirm a live-only recorded input after every recorded flush fails before writing', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(15), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const flush = failRecordedSessionFlushBeforeWrite(harness.context, SESSION_ID)

    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow()
    expect(flush.failures()).toBeGreaterThan(0)
    const liveSnapshot = await harness.context.sessionPersistence.inspect(SESSION_ID, signal)
    expect(liveSnapshot.events.some(event => event.type === 'user/message' && event.data.id === MESSAGE_ID))
      .toBe(true)
    const physicalLog = await harness.context.sessionPersistence.readFrom(SESSION_ID, 0, signal)
    expect(physicalLog.events.some(event => event.type === 'user/message' && event.data.id === MESSAGE_ID))
      .toBe(false)
    expect(await rawSessionHasRecordedInput(harness.context, signal)).toBe(false)
    await expect(harness.execution.inspectOperation(prepared.preparation.operation, signal))
      .rejects.toThrow('recorded Agent Run flush failed before writing')
    flush.restore()

    const replayed = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(replayed).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await rawSessionHasRecordedInput(harness.context, signal)).toBe(true)
    const agent = harness.context.agents.get(SESSION_ID)
    expect(agent?.session.events.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data.inserted)
      .filter(message => message.id === MESSAGE_ID)).toEqual([request.run.input])
  }, 30_000)

  it('durably cancels a pending exact input and never resends it', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(9), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const flush = failNextSessionFlush(harness.context, SESSION_ID)
    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('lost durable Agent Run inbox acknowledgement')
    flush.restore()

    const canceled = await harness.execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )

    expect(canceled).toMatchObject({ state: 'canceled', reason: 'source-canceled', effect: 'none' })
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    expect(harness.adapter.requests).toHaveLength(0)
    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toEqual({ ok: true, snapshot: canceled })
    const durable = await harness.context.sessionPersistence.inspect(SESSION_ID, signal)
    expect(durable.events.filter(event => event.type === 'user/message' && event.data.id === MESSAGE_ID))
      .toHaveLength(0)
    expect(durable.events.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data.inserted)
      .filter(message => message.id === MESSAGE_ID)).toEqual([request.run.input])
    expect(durable.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.outcome === 'canceled' && event.data.removedCount === 1)).toBe(true)
  }, 30_000)

  it('keeps a publishing operation retryable until its live Agent is fully disposed', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(22), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const flush = failNextSessionFlush(harness.context, SESSION_ID)
    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('lost durable Agent Run inbox acknowledgement')
    flush.restore()
    const handles = (harness.execution as unknown as {
      liveAgentRuns: Map<typeof SESSION_ID, { readonly agent: Agent; dispose: () => Promise<void> }>
    }).liveAgentRuns
    const handle = handles.get(SESSION_ID)
    expect(handle).toBeDefined()
    if (handle === undefined) return
    vi.spyOn(handle, 'dispose').mockRejectedValueOnce(new Error('Agent Handle drain failed'))

    await expect(harness.execution.cancelOperation(
      prepared.preparation.operation,
      'authority-revoked',
      signal,
    )).rejects.toThrow('Agent Handle drain failed')

    expect(await harness.execution.inspectOperation(prepared.preparation.operation, signal))
      .toMatchObject({ state: 'publishing' })
    expect(handles.get(SESSION_ID)).toBe(handle)
    expect(harness.context.agents.get(SESSION_ID)).toBe(handle.agent)

    const canceled = await harness.execution.cancelOperation(
      prepared.preparation.operation,
      'authority-revoked',
      signal,
    )

    expect(canceled).toMatchObject({ state: 'canceled', reason: 'authority-revoked', effect: 'none' })
    expect(handles.has(SESSION_ID)).toBe(false)
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
  }, 30_000)

  it('cancels a durable not-started plan without inspecting or creating a Session', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(14), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const persistence = operationPersistence(harness.execution)
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'agent-run'
        && record.effectPlan.publication === 'not-started') {
        throw new Error('lost Agent Run plan acknowledgement')
      }
    })
    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('lost Agent Run plan acknowledgement')
    persistence.restore()

    await expect(harness.execution.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'publishing' })
    const canceled = await harness.execution.cancelOperation(
      prepared.preparation.operation,
      'authority-revoked',
      signal,
    )

    expect(canceled).toMatchObject({ state: 'canceled', reason: 'authority-revoked', effect: 'none' })
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    expect(harness.adapter.requests).toHaveLength(0)
    await expect(harness.context.sessionPersistence.listSnapshots(signal)).resolves.toEqual([])
  }, 30_000)

  it('drops stale Agent Run ownership without disposing an unregistered Agent', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await persistPlannedAgentRun(harness.execution, request, signal, 36)
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const handles = liveAgentRunHandles(harness.execution)
    handles.set(SESSION_ID, { agent: {} as Agent, dispose })

    const canceled = await harness.execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )

    expect(canceled).toMatchObject({ state: 'canceled', effect: 'none' })
    expect(dispose).not.toHaveBeenCalled()
    expect(handles.has(SESSION_ID)).toBe(false)
  }, 30_000)

  it('refuses to cancel while a retained handle disagrees with the live Agent registry', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await persistPlannedAgentRun(harness.execution, request, signal, 37)
    const foreign = await createAgentHandle(harness, binding, request, signal)
    const retained = { agent: {} as Agent, dispose: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }
    const handles = liveAgentRunHandles(harness.execution)
    handles.set(SESSION_ID, retained)

    await expect(harness.execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).rejects.toThrow('owned by a conflicting live Agent')

    expect(handles.get(SESSION_ID)).toBe(retained)
    expect(harness.context.agents.get(SESSION_ID)).toBe(foreign.agent)
    expect(retained.dispose).not.toHaveBeenCalled()
    handles.delete(SESSION_ID)
    await foreign.dispose()
  }, 30_000)

  it('refuses to cancel when Agent disposal returns before registry quiescence', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await persistPlannedAgentRun(harness.execution, request, signal, 38)
    const handle = await createAgentHandle(harness, binding, request, signal)
    const handles = liveAgentRunHandles(harness.execution)
    handles.set(SESSION_ID, handle)
    const dispose = vi.spyOn(handle, 'dispose').mockResolvedValueOnce(undefined)

    await expect(harness.execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).rejects.toThrow('remained live after disposal')

    expect(handles.get(SESSION_ID)).toBe(handle)
    expect(harness.context.agents.get(SESSION_ID)).toBe(handle.agent)
    dispose.mockRestore()
    await handle.dispose()
    handles.delete(SESSION_ID)
  }, 30_000)

  it('cancels an attempting Agent Run when no physical Session exists', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await persistAttemptingAgentRun(harness.execution, request, signal, 31)

    const canceled = await harness.execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )

    expect(canceled).toMatchObject({ state: 'canceled', reason: 'source-canceled', effect: 'none' })
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    await expect(harness.context.sessionPersistence.listSnapshots(signal)).resolves.toEqual([])
  }, 30_000)

  it('reports success when cancellation finds the exact input already recorded', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    await persistInputHistory(harness, binding, request, (persisted) => {
      persisted.append('user/message', request.run.input, { surfaceOp: 'append' })
    })
    const prepared = await persistAttemptingAgentRun(harness.execution, request, signal, 32)

    const canceled = await harness.execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )

    expect(canceled).toMatchObject({ state: 'succeeded', result: { inputMessageId: MESSAGE_ID } })
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    expect(harness.adapter.requests).toHaveLength(0)
  }, 30_000)

  it.each([
    ['conflicting input', 'evidence-conflict'],
    ['claimed input with no record', 'effect-unknown'],
  ] as const)(
    'requires reconciliation when cancellation finds %s evidence',
    async (history, expectedReason) => {
      const harness = await agentRunHarness([])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      await persistInputHistory(harness, binding, request, (persisted) => {
        if (history === 'conflicting input') {
          persisted.append('user/message', freezeMessage({
            ...request.run.input,
            content: [{ type: 'text', text: 'Conflicting recorded input.' }],
          }), { surfaceOp: 'append' })
          return
        }
        persisted.append('agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          inserted: [request.run.input],
        })
        persisted.append('agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          removedCount: 1,
          inserted: [],
        })
      })
      const prepared = await persistAttemptingAgentRun(harness.execution, request, signal, 33)

      const canceled = await harness.execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )

      expect(canceled).toMatchObject({ state: 'reconciliation-required', reason: expectedReason })
      expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
      expect(harness.adapter.requests).toHaveLength(0)
    },
    30_000,
  )

  it('keeps cancellation retryable while its pending physical Session is unavailable', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    await persistPendingInput(harness, binding, request, request.run.input)
    const prepared = await persistAttemptingAgentRun(harness.execution, request, signal, 34)
    vi.spyOn(harness.context.agents, 'resume').mockRejectedValueOnce(new Error('provider unavailable'))
    vi.spyOn(harness.context.logger, 'warn').mockImplementation(() => {})

    const canceled = await harness.execution.cancelOperation(
      prepared.preparation.operation,
      'authority-revoked',
      signal,
    )

    expect(canceled).toMatchObject({ state: 'publishing' })
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    expect(harness.adapter.requests).toHaveLength(0)
  }, 30_000)

  it('reports success when pending input becomes recorded during cancellation drain', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    await persistPendingInput(harness, binding, request, request.run.input)
    const prepared = await persistAttemptingAgentRun(harness.execution, request, signal, 35)
    const resume = harness.context.agents.resume.bind(harness.context.agents)
    vi.spyOn(harness.context.agents, 'resume').mockImplementation(async (options) => {
      const handle = await resume(options)
      const dispose = handle.dispose.bind(handle)
      vi.spyOn(handle, 'dispose').mockImplementation(async () => {
        handle.agent.session.append('agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          removedCount: 1,
          inserted: [],
        })
        handle.agent.session.append('user/message', request.run.input, { surfaceOp: 'append' })
        await harness.context.sessions.flush(handle.agent.session)
        await dispose()
      })
      return handle
    })

    const canceled = await harness.execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )

    expect(canceled).toMatchObject({ state: 'succeeded', result: { inputMessageId: MESSAGE_ID } })
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    const durable = await harness.context.sessionPersistence.readFrom(SESSION_ID, 0, signal)
    expect(durable.events.filter(event => event.type === 'user/message' && event.data.id === MESSAGE_ID))
      .toHaveLength(1)
  }, 30_000)

  it('retains a stale Agent Handle until replacement disposal succeeds', async () => {
    const harness = await agentRunHarness([stopResponse('done')])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    let disposals = 0
    const handles = (harness.execution as unknown as {
      liveAgentRuns: Map<typeof SESSION_ID, { readonly agent: never; dispose: () => Promise<void> }>
    }).liveAgentRuns
    const staleHandle = {
      agent: {} as never,
      dispose: async () => {
        disposals += 1
        if (disposals === 1) throw new Error('stale Agent Handle disposal failed')
      },
    }
    handles.set(SESSION_ID, staleHandle)
    const prepared = await harness.execution.prepareOperation(request, accepted(16), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('stale Agent Handle disposal failed')

    expect(handles.get(SESSION_ID)).toBe(staleHandle)
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()

    const started = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(disposals).toBe(2)
    expect(harness.context.agents.get(SESSION_ID)).toBeDefined()
  }, 60_000)

  it('keeps provider creation failures retryable without trusting thrown values', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(27), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const named = Object.assign(new Error('named failure'), { name: 'AdapterFailure' })
    const nameless = Object.assign(new Error('nameless failure'), { name: '' })
    const create = vi.spyOn(harness.context.agents, 'create')
      .mockRejectedValueOnce(named)
      .mockRejectedValueOnce(nameless)
      .mockRejectedValueOnce('primitive failure')
    const warning = vi.spyOn(harness.context.logger, 'warn').mockImplementation(() => {})

    for (const expectedName of ['AdapterFailure', 'unknown error', 'unknown error']) {
      const result = await harness.execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )
      expect(result).toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
      expect(warning).toHaveBeenLastCalledWith(expect.stringContaining(`is unavailable: ${expectedName}`))
    }

    expect(create).toHaveBeenCalledTimes(3)
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
  }, 60_000)

  it('reconciles a persisted same-id input whose Saki source does not match', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const conflictingInput = freezeMessage({
      ...request.run.input,
      source: {
        ...request.run.input.source,
        dispatchId: 'dispatch-99999999-9999-4999-8999-999999999999' as SakiExecutionDispatchId,
      },
    })
    await persistPendingInput(harness, binding, request, conflictingInput)
    const prepared = await harness.execution.prepareOperation(request, accepted(10), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const started = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
    })
    expect(harness.adapter.requests).toHaveLength(0)
    const durable = await harness.context.sessionPersistence.inspect(SESSION_ID, signal)
    expect(durable.events.filter(event => event.type === 'user/message' && event.data.id === MESSAGE_ID))
      .toHaveLength(0)
    expect(durable.events.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data.inserted)).toContainEqual(conflictingInput)
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
  }, 30_000)

  it.each([
    ['working directory', { cwd: join(tmpdir(), 'saki-conflicting-worktree') }],
    ['Agent preset', { agentPreset: 'conflicting-preset' }],
  ] as const)(
    'reconciles a physical Session whose %s disagrees with the Host request',
    async (_label, meta) => {
      const harness = await agentRunHarness([])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      await persistInputHistory(harness, binding, request, (persisted) => {
        persisted.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] })
      }, meta)
      const prepared = await harness.execution.prepareOperation(request, accepted(28), signal)
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return

      const started = await harness.execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )

      expect(started).toMatchObject({
        ok: true,
        snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
      })
      expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
      expect(harness.adapter.requests).toHaveLength(0)
    },
    30_000,
  )

  it('drains an acquired Agent before publishing conflicting input evidence', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(25), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const create = harness.context.agents.create.bind(harness.context.agents)
    vi.spyOn(harness.context.agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      handle.agent.send(freezeMessage({
        ...request.run.input,
        content: [{ type: 'text', text: 'Conflicting raced input.' }],
      }), 'next-turn', false)
      return handle
    })

    const started = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
    })
    expect(harness.context.agents.get(SESSION_ID) === undefined).toBe(true)
    const handles = (harness.execution as unknown as { liveAgentRuns: Map<typeof SESSION_ID, unknown> }).liveAgentRuns
    expect(handles.has(SESSION_ID)).toBe(false)
    expect(harness.adapter.requests).toHaveLength(0)
  }, 30_000)

  it('does not publish reconciliation while a conflicting live Agent still owns the Session', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(26), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const foreign = await harness.context.agents.create({
      sessionId: SESSION_ID,
      meta: {
        cwd: binding.expectedInspection.trusted.canonicalWorktreePath,
        agentPreset: request.run.profile.agentPresetId,
      },
      agentOptions: {
        provider: request.run.profile.modelRoute.provider,
        model: request.run.profile.modelRoute.model,
      },
    })
    const persisted: LocalHostOperationRecord[] = []
    const persistence = operationPersistence(harness.execution)
    persistence.replace(async (record) => {
      await persistence.original(record)
      persisted.push(record)
    })

    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('conflicting live Agent')

    expect(persisted.at(-1)?.snapshot.state).toBe('publishing')
    expect(harness.context.agents.get(SESSION_ID)).toBe(foreign.agent)
    const handles = (harness.execution as unknown as { liveAgentRuns: Map<typeof SESSION_ID, unknown> }).liveAgentRuns
    expect(handles.has(SESSION_ID)).toBe(false)
    expect(harness.adapter.requests).toHaveLength(0)
    persistence.restore()
    await foreign.dispose()
  }, 30_000)

  it('resumes an exact durable pending input after a host restart', async () => {
    const harness = await agentRunHarness([stopResponse('done')])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    await persistPendingInput(harness, binding, request, request.run.input)
    const prepared = await harness.execution.prepareOperation(request, accepted(12), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const started = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    const agent = harness.context.agents.get(SESSION_ID)
    expect(agent).toBeDefined()
    if (agent === undefined) return
    await agent.whenIdle()
    expect(harness.adapter.requests).toHaveLength(1)
    expect(harness.adapter.requests[0]?.messages.filter(message => message.role === 'user'))
      .toEqual([request.run.input])
    expect(agent.session.events.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data.inserted)
      .filter(message => message.id === MESSAGE_ID)).toEqual([request.run.input])
    expect(agent.session.events.filter(event => event.type === 'user/message' && event.data.id === MESSAGE_ID))
      .toHaveLength(1)
  }, 30_000)

  it('does not wake a durable pending input after its frozen repository becomes stale', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    await persistPendingInput(harness, binding, request, request.run.input)
    const prepared = await harness.execution.prepareOperation(request, accepted(17), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const persistence = operationPersistence(harness.execution)
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'agent-run'
        && record.effectPlan.publication === 'attempting') throw new Error('lost attempting acknowledgement')
    })
    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('lost attempting acknowledgement')
    persistence.restore()
    await writeFile(join(harness.repository, 'tracked.txt'), 'changed after pending input\n')

    const replayed = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(replayed).toMatchObject({
      ok: true,
      snapshot: { state: 'reconciliation-required', reason: 'effect-unknown' },
    })
    expect(harness.adapter.requests).toHaveLength(0)
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
  }, 30_000)

  it('rechecks the frozen repository after Agent resume before waking pending input', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    await persistPendingInput(harness, binding, request, request.run.input)
    const prepared = await harness.execution.prepareOperation(request, accepted(21), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const resume = harness.context.agents.resume.bind(harness.context.agents)
    vi.spyOn(harness.context.agents, 'resume').mockImplementation(async (options) => {
      const handle = await resume(options)
      await writeFile(join(harness.repository, 'tracked.txt'), 'changed while resuming Agent\n')
      return handle
    })

    const started = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: { state: 'reconciliation-required', reason: 'effect-unknown' },
    })
    expect(harness.adapter.requests).toHaveLength(0)
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    const durable = await harness.context.sessionPersistence.readFrom(SESSION_ID, 0, signal)
    expect(durable.events.filter(event => event.type === 'user/message' && event.data.id === MESSAGE_ID))
      .toHaveLength(0)
  }, 30_000)

  it('reconciles duplicate exact recorded inputs as conflicting evidence', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    await persistInputHistory(harness, binding, request, (persisted) => {
      persisted.append('user/message', request.run.input, { surfaceOp: 'append' })
      persisted.append('user/message', request.run.input, { surfaceOp: 'append' })
    })
    const prepared = await harness.execution.prepareOperation(request, accepted(18), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const started = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
    })
    expect(harness.adapter.requests).toHaveLength(0)
  }, 30_000)

  it('rejects an Agent Run plan whose result identities disagree with its request', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(19), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const persistence = operationPersistence(harness.execution)
    let rejected = false
    persistence.replace(async (record) => {
      if (record.effectPlan?.kind === 'agent-run') {
        rejected = !sakiHostExecutionDomainSpec.tables.operations.valueSchema.safeParse({
          ...record,
          effectPlan: {
            ...record.effectPlan,
            result: {
              ...record.effectPlan.result,
              inputMessageId: '88888888-8888-4888-8888-888888888888',
            },
          },
        }).success
        throw new Error('captured Agent Run plan')
      }
      await persistence.original(record)
    })

    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('captured Agent Run plan')
    persistence.restore()
    expect(rejected).toBe(true)
  }, 30_000)

  it('drains a retained live Agent when replaying a non-running terminal Host record', async () => {
    const harness = await agentRunHarness([stopResponse('done')])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation<'start-agent-run'>(request, accepted(24), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const started = await harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    expect(started).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    const live = harness.context.agents.get(SESSION_ID)
    expect(live !== undefined).toBe(true)
    if (live === undefined || started.snapshot.state !== 'succeeded') return
    await live.whenIdle()
    const persistence = operationPersistence(harness.execution)
    const { completedAt: _completedAt, result: _result, ...base } = started.snapshot
    await persistence.original({
      schemaVersion: 4,
      request,
      preparationRevision: prepared.preparation.preparationRevision,
      effectPlan: { kind: 'agent-run', publication: 'applied-recorded', result: started.snapshot.result },
      snapshot: {
        ...base,
        state: 'reconciliation-required',
        revision: base.revision + 1,
        updatedAt: base.updatedAt + 1,
        observedAt: base.updatedAt + 1,
        reason: 'effect-unknown',
      },
    })

    await expect(harness.execution.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'reconciliation-required' })
    expect(harness.context.agents.get(SESSION_ID) === undefined).toBe(true)
    const handles = (harness.execution as unknown as { liveAgentRuns: Map<typeof SESSION_ID, unknown> }).liveAgentRuns
    expect(handles.has(SESSION_ID)).toBe(false)
    expect(harness.adapter.requests).toHaveLength(1)
  }, 30_000)

  it.each(['replaced', 'claimed-without-record'] as const)(
    'never resends an exact input whose durable inbox history is %s',
    async (history) => {
      const harness = await agentRunHarness([])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      await persistInputHistory(harness, binding, request, (persisted) => {
        persisted.append('agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          inserted: [request.run.input],
        })
        persisted.append('agent/inbox/spliced', history === 'replaced'
          ? {
            target: 'next-turn',
            start: 0,
            removedCount: 1,
            inserted: [freezeMessage({
              ...request.run.input,
              id: '88888888-8888-4888-8888-888888888888' as StartAgentRunInputMessage['id'],
              content: [{ type: 'text', text: 'Replacement input.' }],
            })],
            outcome: 'canceled',
          }
          : {
            target: 'next-turn',
            start: 0,
            removedCount: 1,
            inserted: [],
          })
      })
      const prepared = await harness.execution.prepareOperation(request, accepted(13), signal)
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return

      const started = await harness.execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )

      expect(started).toMatchObject({
        ok: true,
        snapshot: { state: 'reconciliation-required', reason: 'effect-unknown' },
      })
      expect(harness.adapter.requests).toHaveLength(0)
      expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
      const durable = await harness.context.sessionPersistence.inspect(SESSION_ID, signal)
      expect(durable.events.filter(event => event.type === 'user/message' && event.data.id === MESSAGE_ID))
        .toHaveLength(0)
      expect(durable.events.filter(event => event.type === 'agent/inbox/spliced')
        .flatMap(event => event.data.inserted)
        .filter(message => message.id === MESSAGE_ID)).toEqual([request.run.input])
    },
    30_000,
  )

  it('returns a prepared Agent Run unchanged during inspection', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(39), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    await expect(harness.execution.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toEqual(prepared.snapshot)
  }, 30_000)

  it.each([
    ['mismatched Session identity', 'mismatch', 'evidence-conflict'],
    ['exact recorded input', 'recorded', 'succeeded'],
    ['conflicting recorded input', 'conflict', 'evidence-conflict'],
    ['claimed input without a record', 'unknown', 'effect-unknown'],
  ] as const)(
    'reconciles an attempting Agent Run with %s during inspection',
    async (_label, history, expected) => {
      const harness = await agentRunHarness([])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      const prepared = await persistAttemptingAgentRun(harness.execution, request, signal, 40)
      await persistInputHistory(harness, binding, request, (persisted) => {
        if (history === 'recorded') {
          persisted.append('user/message', request.run.input, { surfaceOp: 'append' })
        } else if (history === 'conflict') {
          persisted.append('user/message', freezeMessage({
            ...request.run.input,
            content: [{ type: 'text', text: 'Conflicting recorded input.' }],
          }), { surfaceOp: 'append' })
        } else if (history === 'unknown') {
          persisted.append('agent/inbox/spliced', {
            target: 'next-turn',
            start: 0,
            inserted: [request.run.input],
          })
          persisted.append('agent/inbox/spliced', {
            target: 'next-turn',
            start: 0,
            removedCount: 1,
            inserted: [],
          })
        } else {
          persisted.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] })
        }
      }, history === 'mismatch' ? { cwd: join(tmpdir(), 'saki-conflicting-worktree') } : {})

      const inspected = await harness.execution.inspectOperation(prepared.preparation.operation, signal)

      if (expected === 'succeeded') {
        expect(inspected).toMatchObject({ state: 'succeeded' })
      } else {
        expect(inspected).toMatchObject({ state: 'reconciliation-required', reason: expected })
      }
      expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    },
    30_000,
  )

  it.each(['before', 'after'] as const)(
    'recovers inspection when the applied-recorded acknowledgement is lost %s persistence',
    async (failurePoint) => {
      const harness = await agentRunHarness([stopResponse('done')])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      const prepared = await harness.execution.prepareOperation(request, accepted(41), signal)
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      const persistence = operationPersistence(harness.execution)
      persistence.replace(async (record) => {
        if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'agent-run'
          && record.effectPlan.publication === 'applied-recorded') {
          if (failurePoint === 'after') await persistence.original(record)
          throw new Error(`lost applied-recorded acknowledgement ${failurePoint} persistence`)
        }
        await persistence.original(record)
      })

      await expect(harness.execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).rejects.toThrow(`lost applied-recorded acknowledgement ${failurePoint} persistence`)
      persistence.restore()

      await expect(harness.execution.inspectOperation(prepared.preparation.operation, signal))
        .resolves.toMatchObject({ state: 'succeeded' })
      expect(harness.context.agents.get(SESSION_ID)).toBeDefined()
    },
    60_000,
  )

  it('reconciles succeeded Host evidence when its physical Session disappears', async () => {
    const harness = await agentRunHarness([stopResponse('done')])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(42), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    vi.spyOn(harness.context.sessionPersistence, 'listSnapshots').mockResolvedValueOnce([])

    await expect(harness.execution.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'reconciliation-required', reason: 'effect-unknown' })
    expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
  }, 30_000)

  it.each([
    ['a mismatched physical Session', 'mismatch', 'evidence-conflict'],
    ['no exact input', 'absent', 'effect-unknown'],
  ] as const)(
    'cancels an attempting Agent Run with %s without creating an Agent',
    async (_label, history, expected) => {
      const harness = await agentRunHarness([])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      const prepared = await persistAttemptingAgentRun(harness.execution, request, signal, 43)
      await persistInputHistory(harness, binding, request, (persisted) => {
        persisted.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] })
      }, history === 'mismatch' ? { agentPreset: 'conflicting-preset' } : {})

      const canceled = await harness.execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )

      if (history === 'absent') {
        expect(canceled).toMatchObject({ state: 'canceled', effect: 'none' })
      } else {
        expect(canceled).toMatchObject({ state: 'reconciliation-required', reason: expected })
      }
      expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    },
    30_000,
  )

  it.each(['removed-conflict', 'malformed-wake'] as const)(
    'rejects %s in durable Agent Run inbox history',
    async (history) => {
      const harness = await agentRunHarness([])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      await persistInputHistory(harness, binding, request, (persisted) => {
        if (history === 'removed-conflict') {
          const conflicting = freezeMessage({
            ...request.run.input,
            content: [{ type: 'text', text: 'Conflicting removed input.' }],
          })
          persisted.append('agent/inbox/spliced', {
            target: 'next-turn',
            start: 0,
            inserted: [conflicting],
          })
          persisted.append('agent/inbox/spliced', {
            target: 'next-turn',
            start: 0,
            removedCount: 1,
            inserted: [],
          })
        } else {
          persisted.append('agent/inbox/spliced', {
            target: 'next-step',
            start: 0,
            inserted: [freezeMessage({
              id: 'malformed-agent-run-wake' as StartAgentRunInputMessage['id'],
              role: 'user',
              content: [{ type: 'text', text: 'Malformed wake.' }],
              source: { kind: 'saki-agent-run-wake', agentRunId: AGENT_RUN_ID, ordinal: -1 },
            })],
          })
        }
      })
      const prepared = await harness.execution.prepareOperation(request, accepted(44), signal)
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return

      await expect(harness.execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).resolves.toMatchObject({
        ok: true,
        snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
      })
      expect(harness.adapter.requests).toHaveLength(0)
    },
    30_000,
  )

  it.each(['advance', 'inspect', 'cancel'] as const)(
    'reconciles a transient live Agent ownership conflict during %s',
    async (action) => {
      const harness = await agentRunHarness([])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      const prepared = action === 'advance'
        ? await harness.execution.prepareOperation(request, accepted(45), signal)
        : await persistAttemptingAgentRun(harness.execution, request, signal, 45)
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      scriptAgentRegistryReads(harness, [{} as Agent, undefined])

      const snapshot = action === 'advance'
        ? (await harness.execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).snapshot
        : action === 'inspect'
          ? await harness.execution.inspectOperation(prepared.preparation.operation, signal)
          : await harness.execution.cancelOperation(
            prepared.preparation.operation,
            'source-canceled',
            signal,
          )

      expect(snapshot).toMatchObject({ state: 'reconciliation-required', reason: 'evidence-conflict' })
      expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    },
    30_000,
  )

  it.each(['before-check', 'during-inspection', 'provider-failure'] as const)(
    'reconciles live Agent ownership that appears at %s during acquisition',
    async (point) => {
      const harness = await agentRunHarness([])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      const prepared = await harness.execution.prepareOperation(request, accepted(46), signal)
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      const foreign = {} as Agent
      const reads = point === 'before-check'
        ? [undefined, foreign, undefined]
        : point === 'during-inspection'
          ? [undefined, undefined, foreign, undefined]
          : [undefined, undefined, undefined, foreign, undefined]
      scriptAgentRegistryReads(harness, reads)
      if (point === 'provider-failure') {
        vi.spyOn(harness.context.agents, 'create').mockRejectedValueOnce(new Error('provider raced with ownership'))
      }

      await expect(harness.execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).resolves.toMatchObject({
        ok: true,
        snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
      })
    },
    30_000,
  )

  it.each(['start', 'cancel'] as const)(
    'reconciles when physical Session identity changes during %s acquisition',
    async (action) => {
      const harness = await agentRunHarness([])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      const prepared = action === 'start'
        ? await harness.execution.prepareOperation(request, accepted(47), signal)
        : await persistAttemptingAgentRun(harness.execution, request, signal, 47)
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      await persistPendingInput(harness, binding, request, request.run.input)
      changeSessionIdentityOnRead(harness, 2)

      const snapshot = action === 'start'
        ? (await harness.execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).snapshot
        : await harness.execution.cancelOperation(
          prepared.preparation.operation,
          'authority-revoked',
          signal,
        )

      expect(snapshot).toMatchObject({ state: 'reconciliation-required', reason: 'evidence-conflict' })
      expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    },
    30_000,
  )

  it.each(['absent', 'mismatch', 'ownership-conflict'] as const)(
    'reconciles %s durable evidence after sending exact input',
    async (failure) => {
      const harness = await agentRunHarness([])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      const prepared = await harness.execution.prepareOperation(request, accepted(48), signal)
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      let inputFlushed = false
      const sessions = harness.context.sessions as unknown as {
        flush: (session: { readonly id: typeof SESSION_ID; readonly events: readonly { readonly type: string }[] }) => Promise<boolean>
      }
      const flush = sessions.flush.bind(sessions)
      sessions.flush = async (session) => {
        const result = await flush(session)
        if (session.id === SESSION_ID && session.events.some(event => event.type === 'agent/inbox/spliced')) {
          inputFlushed = true
        }
        return result
      }
      const listSnapshots = harness.context.sessionPersistence.listSnapshots.bind(harness.context.sessionPersistence)
      vi.spyOn(harness.context.sessionPersistence, 'listSnapshots').mockImplementation(async inspectionSignal =>
        failure === 'absent' && inputFlushed ? [] : await listSnapshots(inspectionSignal))
      const readFrom = harness.context.sessionPersistence.readFrom.bind(harness.context.sessionPersistence)
      vi.spyOn(harness.context.sessionPersistence, 'readFrom').mockImplementation(async (...args) => {
        const persisted = await readFrom(...args)
        return failure === 'mismatch' && inputFlushed
          ? { ...persisted, meta: { ...persisted.meta, cwd: join(tmpdir(), 'saki-changed-after-flush') } }
          : persisted
      })
      const getAgent = harness.context.agents.get.bind(harness.context.agents)
      let reportedConflict = false
      vi.spyOn(harness.context.agents, 'get').mockImplementation((sessionId) => {
        if (failure === 'ownership-conflict' && inputFlushed && !reportedConflict) {
          reportedConflict = true
          return {} as Agent
        }
        return getAgent(sessionId)
      })

      const started = await harness.execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )

      expect(started).toMatchObject({
        ok: true,
        snapshot: {
          state: 'reconciliation-required',
          reason: failure === 'absent' ? 'effect-unknown' : 'evidence-conflict',
        },
      })
      expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    },
    30_000,
  )

  it('keeps replacement ownership installed while disposing a canceled Agent Run', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await persistPlannedAgentRun(harness.execution, request, signal, 49)
    const handle = await createAgentHandle(harness, binding, request, signal)
    const handles = liveAgentRunHandles(harness.execution)
    handles.set(SESSION_ID, handle)
    const replacement = { agent: handle.agent, dispose: vi.fn(async () => {}) }
    const dispose = handle.dispose.bind(handle)
    vi.spyOn(handle, 'dispose').mockImplementation(async () => {
      await dispose()
      handles.set(SESSION_ID, replacement)
    })

    await expect(harness.execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).resolves.toMatchObject({ state: 'canceled', effect: 'none' })

    expect(handles.get(SESSION_ID)).toBe(replacement)
    expect(replacement.dispose).not.toHaveBeenCalled()
    handles.delete(SESSION_ID)
  }, 30_000)

  it('rechecks replacement ownership after a stale retained handle is disposed', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(50), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const handles = liveAgentRunHandles(harness.execution)
    const replacementAgent = {} as Agent
    const replacement = { agent: replacementAgent, dispose: vi.fn(async () => {}) }
    const stale = {
      agent: {} as Agent,
      dispose: vi.fn(async () => { handles.set(SESSION_ID, replacement) }),
    }
    handles.set(SESSION_ID, stale)
    scriptAgentRegistryReads(harness, [undefined, undefined, replacementAgent, replacementAgent, undefined])

    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
    })

    expect(stale.dispose).toHaveBeenCalledOnce()
    expect(replacement.dispose).toHaveBeenCalledOnce()
    expect(handles.has(SESSION_ID)).toBe(false)
  }, 30_000)

  it('rejects succeeded recovery when physical evidence disappears after inspection', async () => {
    const { operation, request, restarted, signal } = await restartedSucceededAgentRun()
    const listSnapshots = restarted.context.sessionPersistence.listSnapshots.bind(restarted.context.sessionPersistence)
    let inspections = 0
    vi.spyOn(restarted.context.sessionPersistence, 'listSnapshots').mockImplementation(async (inspectionSignal) => {
      inspections += 1
      return inspections === 2 ? [] : await listSnapshots(inspectionSignal)
    })

    await expect(restarted.execution.resumeAgentRun(operation, request, signal))
      .rejects.toThrow('lacks its exact physical Session input')
    expect(restarted.context.agents.get(SESSION_ID)).toBeUndefined()
  }, 60_000)

  it('rejects succeeded recovery when its Session provider is unavailable', async () => {
    const { operation, request, restarted, signal } = await restartedSucceededAgentRun()
    vi.spyOn(restarted.context.agents, 'resume').mockRejectedValueOnce(new Error('resume provider unavailable'))

    await expect(restarted.execution.resumeAgentRun(operation, request, signal))
      .rejects.toThrow('Session recovery is unavailable')
    expect(restarted.context.agents.get(SESSION_ID)).toBeUndefined()
  }, 60_000)

  it('rejects a retained recovered Agent whose model route conflicts with the Host request', async () => {
    const { operation, request, restarted, signal } = await restartedSucceededAgentRun()
    const retained = await restarted.context.agents.resume({
      resumeSessionId: SESSION_ID,
      agentOptions: { provider: request.run.profile.modelRoute.provider, model: 'conflicting-model' },
      setup: async () => {},
      signal,
    })
    const handles = liveAgentRunHandles(restarted.execution)
    handles.set(SESSION_ID, retained)

    await expect(restarted.execution.resumeAgentRun(operation, request, signal))
      .rejects.toThrow('restored a conflicting Session configuration')
    expect(restarted.context.agents.get(SESSION_ID)).toBeUndefined()
    expect(handles.has(SESSION_ID)).toBe(false)
  }, 60_000)

  it('rejects succeeded recovery when physical evidence disappears after Agent resume', async () => {
    const { operation, request, restarted, signal } = await restartedSucceededAgentRun()
    const resume = restarted.context.agents.resume.bind(restarted.context.agents)
    let resumed = false
    vi.spyOn(restarted.context.agents, 'resume').mockImplementation(async (options) => {
      const handle = await resume(options)
      resumed = true
      return handle
    })
    const listSnapshots = restarted.context.sessionPersistence.listSnapshots.bind(restarted.context.sessionPersistence)
    vi.spyOn(restarted.context.sessionPersistence, 'listSnapshots').mockImplementation(async inspectionSignal =>
      resumed ? [] : await listSnapshots(inspectionSignal))

    await expect(restarted.execution.resumeAgentRun(operation, request, signal))
      .rejects.toThrow('lost exact physical Session evidence during recovery')
    expect(restarted.context.agents.get(SESSION_ID)).toBeUndefined()
    expect(liveAgentRunHandles(restarted.execution).has(SESSION_ID)).toBe(false)
  }, 60_000)

  it('reports success when cancellation observes exact input recorded during Agent resume', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await persistAttemptingAgentRun(harness.execution, request, signal, 51)
    await persistPendingInput(harness, binding, request, request.run.input)
    const resume = harness.context.agents.resume.bind(harness.context.agents)
    vi.spyOn(harness.context.agents, 'resume').mockImplementation(async (options) => {
      const handle = await resume(options)
      handle.agent.session.append('agent/inbox/spliced', {
        target: 'next-turn',
        start: 0,
        removedCount: 1,
        inserted: [],
      })
      handle.agent.session.append('user/message', request.run.input, { surfaceOp: 'append' })
      await harness.context.sessions.flush(handle.agent.session)
      return handle
    })

    await expect(harness.execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).resolves.toMatchObject({ state: 'succeeded' })
    expect(harness.context.agents.get(SESSION_ID)).toBeDefined()
  }, 60_000)

  it.each(['evidence-conflict', 'effect-unknown'] as const)(
    'reconciles %s when cancellation drain changes pending input evidence',
    async (expectedReason) => {
      const harness = await agentRunHarness([])
      const signal = new AbortController().signal
      const binding = await activeBinding(harness.execution, harness.repository, signal)
      const request = await startAgentRunRequest(harness.execution, binding, signal)
      const prepared = await persistAttemptingAgentRun(harness.execution, request, signal, 52)
      await persistPendingInput(harness, binding, request, request.run.input)
      const resume = harness.context.agents.resume.bind(harness.context.agents)
      vi.spyOn(harness.context.agents, 'resume').mockImplementation(async (options) => {
        const handle = await resume(options)
        const dispose = handle.dispose.bind(handle)
        vi.spyOn(handle, 'dispose').mockImplementation(async () => {
          handle.agent.session.append('agent/inbox/spliced', {
            target: 'next-turn',
            start: 0,
            removedCount: 1,
            inserted: [],
          })
          if (expectedReason === 'evidence-conflict') {
            handle.agent.session.append('user/message', freezeMessage({
              ...request.run.input,
              content: [{ type: 'text', text: 'Conflicting input recorded during cancellation.' }],
            }), { surfaceOp: 'append' })
          }
          await harness.context.sessions.flush(handle.agent.session)
          await dispose()
        })
        return handle
      })

      await expect(harness.execution.cancelOperation(
        prepared.preparation.operation,
        'authority-revoked',
        signal,
      )).resolves.toMatchObject({ state: 'reconciliation-required', reason: expectedReason })
      expect(harness.context.agents.get(SESSION_ID)).toBeUndefined()
    },
    60_000,
  )

  it('preserves a downstream pre-step rejection while keeping the exact input recoverable', async () => {
    const harness = await agentRunHarness([])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(53), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const create = harness.context.agents.create.bind(harness.context.agents)
    vi.spyOn(harness.context.agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      handle.agent.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
      return handle
    })

    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('became idle before recording its exact input')
    await expect(harness.execution.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'reconciliation-required', reason: 'effect-unknown' })
  }, 60_000)

  it('replays an applied-recorded publication acknowledgement lost before success', async () => {
    const harness = await agentRunHarness([stopResponse('done')])
    const signal = new AbortController().signal
    const binding = await activeBinding(harness.execution, harness.repository, signal)
    const request = await startAgentRunRequest(harness.execution, binding, signal)
    const prepared = await harness.execution.prepareOperation(request, accepted(54), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const persistence = operationPersistence(harness.execution)
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'agent-run'
        && record.effectPlan.publication === 'applied-recorded') {
        throw new Error('lost success acknowledgement after applied-recorded persistence')
      }
    })
    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('lost success acknowledgement after applied-recorded persistence')
    persistence.restore()

    await expect(harness.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
  }, 60_000)

  it.each(['start', 'resume', 'cancel'] as const)(
    'revalidates physical Session identity before terminal Agent Run %s',
    async (entry) => {
      const { operation, request, restarted, signal } = await restartedSucceededAgentRun()
      const readFrom = restarted.context.sessionPersistence.readFrom.bind(restarted.context.sessionPersistence)
      vi.spyOn(restarted.context.sessionPersistence, 'readFrom').mockImplementation(async (...args) => {
        const persisted = await readFrom(...args)
        return {
          ...persisted,
          meta: { ...persisted.meta, cwd: join(tmpdir(), 'saki-terminal-session-drift') },
        }
      })

      if (entry === 'resume') {
        await expect(restarted.execution.resumeAgentRun(operation, request, signal))
          .rejects.toThrow('is not exactly succeeded')
        return
      }
      if (entry === 'cancel') {
        await expect(restarted.execution.cancelOperation(operation, 'authority-revoked', signal))
          .resolves.toMatchObject({ state: 'reconciliation-required', reason: 'evidence-conflict' })
        return
      }
      const prepared = await restarted.execution.prepareOperation(request, accepted(56), signal)
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      await expect(restarted.execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).resolves.toMatchObject({
        ok: true,
        snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
      })
    },
    60_000,
  )

  it('replays a successful operation after provider restart without resending its input', async () => {
    const world = await createAgentRunWorld()
    const first = await mountAgentRunHarness(world, [stopResponse('done')])
    const signal = new AbortController().signal
    const binding = await activeBinding(first.execution, world.repository, signal)
    const request = await startAgentRunRequest(first.execution, binding, signal)
    const prepared = await first.execution.prepareOperation<'start-agent-run'>(request, accepted(11), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const started = await first.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    expect(started).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    const agent = first.context.agents.get(SESSION_ID)
    expect(agent).toBeDefined()
    if (agent === undefined) return
    await agent.whenIdle()
    await first.context.sessions.flush(agent.session)
    await disposeContext(first.context)

    const restarted = await mountAgentRunHarness(world, [])
    await restarted.execution.resumeAgentRun(prepared.preparation.operation, request, signal)
    const resumedAgent = restarted.context.agents.get(SESSION_ID)
    expect(resumedAgent).toBeDefined()
    expect(resumedAgent?.session.id).toBe(SESSION_ID)
    expect(restarted.adapter.requests).toHaveLength(0)
    const replayedPreparation = await restarted.execution.prepareOperation(request, accepted(11), signal)
    expect(replayedPreparation.ok).toBe(true)
    if (!replayedPreparation.ok) return
    const replayed = await restarted.execution.startOperation(
      replayedPreparation.preparation.operation,
      replayedPreparation.acceptance,
      signal,
    )

    expect(replayed).toEqual({ ok: true, snapshot: replayedPreparation.snapshot })
    expect(replayed).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          agentRunId: AGENT_RUN_ID,
          workSessionId: WORK_SESSION_ID,
          sessionId: SESSION_ID,
          inputMessageId: MESSAGE_ID,
        },
      },
    })
    expect(restarted.adapter.requests).toHaveLength(0)
    const durable = await restarted.context.sessionPersistence.inspect(SESSION_ID, signal)
    expect(durable.events.filter(event => event.type === 'user/message' && event.data.id === MESSAGE_ID))
      .toHaveLength(1)
  }, 30_000)

  it('rejects recovery request drift before resuming the physical Session', async () => {
    const world = await createAgentRunWorld()
    const first = await mountAgentRunHarness(world, [stopResponse('done')])
    const signal = new AbortController().signal
    const binding = await activeBinding(first.execution, world.repository, signal)
    const request = await startAgentRunRequest(first.execution, binding, signal)
    const prepared = await first.execution.prepareOperation<'start-agent-run'>(request, accepted(25), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const started = await first.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    expect(started).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    const agent = first.context.agents.get(SESSION_ID)
    expect(agent).toBeDefined()
    if (agent === undefined) return
    await agent.whenIdle()
    await first.context.sessions.flush(agent.session)
    await disposeContext(first.context)

    const restarted = await mountAgentRunHarness(world, [])
    const conflicting: StartAgentRunHostOperationRequest = {
      ...request,
      run: {
        ...request.run,
        profile: {
          ...request.run.profile,
          modelRoute: { ...request.run.profile.modelRoute, model: 'conflicting-model' },
        },
      },
    }

    await expect(restarted.execution.resumeAgentRun(
      prepared.preparation.operation,
      conflicting,
      signal,
    )).rejects.toThrow('disagrees with its exact recovery request')
    expect(restarted.context.agents.get(SESSION_ID)).toBeUndefined()
    expect(restarted.adapter.requests).toHaveLength(0)
  }, 30_000)
})

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly responses: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('ScriptedAdapter exhausted')
    for (const chunk of response) yield chunk
  }
}

function stopResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function agentRunInput(text: string): StartAgentRunInputMessage {
  return freezeMessage({
    id: MESSAGE_ID,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'saki-agent-run',
      dispatchId: DISPATCH_ID,
      agentRunId: AGENT_RUN_ID,
      workSessionId: WORK_SESSION_ID,
    },
  }) as StartAgentRunInputMessage
}

function interventionAnswerInput(): StartAgentRunInputMessage {
  return freezeMessage({
    id: ANSWER_MESSAGE_ID,
    role: 'user',
    content: [{ type: 'text', text: 'Operator answer: proceed.' }],
    source: {
      kind: 'saki-intervention-answer',
      interventionId: INTERVENTION_ID,
      answerIntentId: ANSWER_INTENT_ID,
      dispatchId: ANSWER_DISPATCH_ID,
      agentRunId: AGENT_RUN_ID,
      workSessionId: WORK_SESSION_ID,
      actor: {
        installationId: INSTALLATION_ID,
        storageGenerationId: STORAGE_GENERATION_ID,
        hostId: HOST_ID,
        principalId: PRINCIPAL_ID,
        principalRevision: 4,
        grantId: GRANT_ID,
        grantRevision: 9,
      },
    },
  }) as StartAgentRunInputMessage
}

function interventionAnswerRequest(
  initial: StartAgentRunHostOperationRequest,
  input: StartAgentRunInputMessage,
): StartAgentRunHostOperationRequest {
  return {
    ...initial,
    source: {
      kind: 'execution-dispatch',
      dispatchId: ANSWER_DISPATCH_ID,
      payloadDigest: computeStartAgentRunPayloadDigest(input),
    },
    run: { ...initial.run, input },
  }
}

async function createAgentHandle(
  harness: AgentRunHarness,
  binding: ActiveHostProjectBinding,
  request: StartAgentRunHostOperationRequest,
  signal: AbortSignal,
) {
  return await harness.context.agents.create({
    sessionId: SESSION_ID,
    meta: {
      cwd: binding.expectedInspection.trusted.canonicalWorktreePath,
      agentPreset: request.run.profile.agentPresetId,
    },
    agentOptions: {
      provider: request.run.profile.modelRoute.provider,
      model: request.run.profile.modelRoute.model,
    },
    signal,
  })
}

interface AgentRunWorld {
  readonly repository: string
  readonly storageRoot: string
  readonly sessionRoot: string
  readonly presetRoot: string
}

interface AgentRunHarness {
  readonly context: Context
  readonly execution: LocalSakiHostExecution
  readonly adapter: ScriptedAdapter
  readonly repository: string
}

async function agentRunHarness(responses: StreamChunk[][]): Promise<AgentRunHarness> {
  return await mountAgentRunHarness(await createAgentRunWorld(), responses)
}

async function restartedSucceededAgentRun(responses: StreamChunk[][] = []) {
  const world = await createAgentRunWorld()
  const first = await mountAgentRunHarness(world, [stopResponse('done')])
  const signal = new AbortController().signal
  const binding = await activeBinding(first.execution, world.repository, signal)
  const request = await startAgentRunRequest(first.execution, binding, signal)
  const prepared = await first.execution.prepareOperation<'start-agent-run'>(request, accepted(55), signal)
  if (!prepared.ok) throw new Error(`test Agent Run was not prepared: ${prepared.reason}`)
  const started = await first.execution.startOperation(
    prepared.preparation.operation,
    prepared.acceptance,
    signal,
  )
  if (!started.ok || started.snapshot.state !== 'succeeded') {
    throw new Error('test Agent Run did not succeed before restart')
  }
  const agent = first.context.agents.get(SESSION_ID)
  if (agent === undefined) throw new Error('test Agent Run has no live Agent before restart')
  await agent.whenIdle()
  await first.context.sessions.flush(agent.session)
  await disposeContext(first.context)
  return {
    operation: prepared.preparation.operation,
    request,
    restarted: await mountAgentRunHarness(world, responses),
    signal,
  }
}

async function createAgentRunWorld(): Promise<AgentRunWorld> {
  const repository = await createRepository()
  const storageRoot = await mkdtemp(join(tmpdir(), 'saki-agent-run-storage-'))
  const sessionRoot = await mkdtemp(join(tmpdir(), 'saki-agent-run-sessions-'))
  const presetRoot = await mkdtemp(join(tmpdir(), 'saki-agent-run-presets-'))
  roots.push(storageRoot, sessionRoot, presetRoot)
  await mkdir(join(presetRoot, 'development'))
  await writeFile(join(presetRoot, 'development', 'agent.cordis.yml'), '[]\n')
  return { repository, storageRoot, sessionRoot, presetRoot }
}

async function mountAgentRunHarness(
  world: AgentRunWorld,
  responses: StreamChunk[][],
): Promise<AgentRunHarness> {
  const { presetRoot, repository, sessionRoot, storageRoot } = world
  const context = new Context()
  contexts.push(context)
  context.baseUrl = pathToFileURL(`${presetRoot}/`).href
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  await context.plugin(LlmRuntime)
  await context.plugin(SessionStore)
  await context.plugin(SystemPrompt, { persona: '' })
  await context.plugin(ToolRuntime)
  await context.plugin(AgentRegistry)
  await context.plugin(AgentLoop, { agents: [] })
  await context.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await context.plugin(SessionCheckpointPolicy)
  await context.plugin(AgentPresets, {
    default: 'development',
    roots: [{ path: presetRoot, trust: 'system' }],
    includeUserRoot: false,
  })
  await context.plugin(Storage)
  await context.plugin(StorageSqlite, { path: join(storageRoot, 'saki.db'), journalMode: 'delete' })
  await context.plugin(StorageDomain, { backend: 'sqlite' })
  await context.plugin(LocalFileSystem, { cwd: process.cwd() })
  await context.plugin(LocalSubprocessRuntime)
  context.provide('workspaceRegistry', { list: () => [{ id: WORKSPACE_ID, path: repository }] })
  const adapter = new ScriptedAdapter(responses)
  context.llm.registerAdapter(['test-provider'], adapter)
  await context.plugin(LocalSakiHostExecution, CONFIG)
  return {
    context,
    execution: context.sakiHostExecution as LocalSakiHostExecution,
    adapter,
    repository,
  }
}

async function disposeContext(context: Context): Promise<void> {
  const index = contexts.indexOf(context)
  if (index >= 0) contexts.splice(index, 1)
  await context.fiber.dispose()
}

async function persistPendingInput(
  harness: AgentRunHarness,
  binding: ActiveHostProjectBinding,
  request: StartAgentRunHostOperationRequest,
  input: StartAgentRunInputMessage,
): Promise<void> {
  await persistInputHistory(harness, binding, request, (persisted) => {
    persisted.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [input],
    })
  })
}

async function persistInputHistory(
  harness: AgentRunHarness,
  binding: ActiveHostProjectBinding,
  request: StartAgentRunHostOperationRequest,
  append: (session: Session) => void,
  meta: { readonly cwd?: string; readonly agentPreset?: string } = {},
): Promise<void> {
  const persisted = Session.create(SESSION_ID, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SESSION_ID,
    createdAt: Date.now(),
    cwd: meta.cwd ?? binding.expectedInspection.trusted.canonicalWorktreePath,
    agentPreset: meta.agentPreset ?? request.run.profile.agentPresetId,
  })
  append(persisted)
  await harness.context.sessionPersistence.create(persisted.header)
  await harness.context.sessionPersistence.append(SESSION_ID, persisted.events)
}

async function activeBinding(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
): Promise<ActiveHostProjectBinding> {
  const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
  if (!selected.ok) throw new Error(`test repository was not selectable: ${selected.reason}`)
  return {
    id: BINDING_ID,
    revision: 0,
    health: 'active',
    hostId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    expectedInspection: selected.inspection,
    inheritedChangeBaseline: selected.inspection.projection.baseline,
  }
}

async function startAgentRunRequest(
  execution: LocalSakiHostExecution,
  binding: ActiveHostProjectBinding,
  signal: AbortSignal,
): Promise<StartAgentRunHostOperationRequest> {
  const inspected = await execution.inspectProject({ binding }, signal)
  if (!inspected.ok || inspected.observation.head.kind !== 'commit'
    || inspected.observation.index.kind !== 'tree'
    || inspected.preEffectBaseline.kind !== 'complete') {
    throw new Error('test binding is not ready for StartAgentRun')
  }
  const input: StartAgentRunInputMessage = {
    id: MESSAGE_ID,
    role: 'user',
    content: [{ type: 'text', text: 'Implement the issue exactly once.' }],
    source: {
      kind: 'saki-agent-run',
      dispatchId: DISPATCH_ID,
      agentRunId: AGENT_RUN_ID,
      workSessionId: WORK_SESSION_ID,
    },
  }
  return {
    type: 'start-agent-run',
    source: {
      kind: 'execution-dispatch',
      dispatchId: DISPATCH_ID,
      payloadDigest: computeStartAgentRunPayloadDigest(input),
    },
    expected: {
      binding,
      status: inspected.observation.fingerprint,
      head: inspected.observation.head,
      index: inspected.observation.index,
      worktree: inspected.observation.worktree,
      preEffectBaseline: inspected.preEffectBaseline,
    },
    run: {
      agentRunId: AGENT_RUN_ID,
      workSessionId: WORK_SESSION_ID,
      sessionId: SESSION_ID,
      profile: {
        id: AGENT_PROFILE_ID,
        version: 1,
        agentPresetId: 'development',
        modelRoute: { provider: 'test-provider', model: 'test-model' },
      },
      input,
    },
  }
}

function accepted(admissionRevision: number): HostOperationAdmissionSource {
  return async () => ({ kind: 'accepted', admissionRevision })
}

function failNextSessionFlush(context: Context, sessionId: typeof SESSION_ID): {
  readonly didFail: () => boolean
  readonly restore: () => void
} {
  const sessions = context.sessions as unknown as {
    flush: (session: { readonly id: typeof SESSION_ID }) => Promise<boolean>
  }
  const original = sessions.flush.bind(sessions)
  let failed = false
  sessions.flush = async (session) => {
    const flushed = await original(session)
    if (!failed && session.id === sessionId) {
      failed = true
      throw new Error('lost durable Agent Run inbox acknowledgement')
    }
    return flushed
  }
  return {
    didFail: () => failed,
    restore: () => { sessions.flush = original },
  }
}

function failRecordedSessionFlushBeforeWrite(context: Context, sessionId: typeof SESSION_ID): {
  readonly failures: () => number
  readonly restore: () => void
} {
  const sessions = context.sessions as unknown as {
    flush: (session: { readonly id: typeof SESSION_ID; readonly events: readonly { readonly type: string }[] }) => Promise<boolean>
  }
  const original = sessions.flush.bind(sessions)
  let failures = 0
  sessions.flush = async (session) => {
    if (session.id === sessionId && session.events.some(event => event.type === 'user/message')) {
      failures += 1
      throw new Error('recorded Agent Run flush failed before writing')
    }
    return await original(session)
  }
  return {
    failures: () => failures,
    restore: () => { sessions.flush = original },
  }
}

async function rawSessionHasRecordedInput(context: Context, signal: AbortSignal): Promise<boolean> {
  const raw = await context.sessionPersistence.readRaw(SESSION_ID, signal)
  return raw?.content.includes('"type":"user/message"') === true
}

function operationPersistence(execution: LocalSakiHostExecution): {
  readonly original: (record: LocalHostOperationRecord) => Promise<void>
  readonly replace: (replacement: (record: LocalHostOperationRecord) => Promise<void>) => void
  readonly restore: () => void
} {
  const target = execution as unknown as {
    persistOperation: (record: LocalHostOperationRecord) => Promise<void>
  }
  const original = target.persistOperation.bind(execution)
  return {
    original,
    replace: (replacement) => { target.persistOperation = replacement },
    restore: () => { target.persistOperation = original },
  }
}

async function persistAttemptingAgentRun(
  execution: LocalSakiHostExecution,
  request: StartAgentRunHostOperationRequest,
  signal: AbortSignal,
  admissionRevision: number,
) {
  const prepared = await execution.prepareOperation(request, accepted(admissionRevision), signal)
  if (!prepared.ok) throw new Error(`test Agent Run was not prepared: ${prepared.reason}`)
  const persistence = operationPersistence(execution)
  persistence.replace(async (record) => {
    await persistence.original(record)
    if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'agent-run'
      && record.effectPlan.publication === 'attempting') {
      throw new Error('captured attempting Agent Run')
    }
  })
  await expect(execution.startOperation(
    prepared.preparation.operation,
    prepared.acceptance,
    signal,
  )).rejects.toThrow('captured attempting Agent Run')
  persistence.restore()
  return prepared
}

async function persistPlannedAgentRun(
  execution: LocalSakiHostExecution,
  request: StartAgentRunHostOperationRequest,
  signal: AbortSignal,
  admissionRevision: number,
) {
  const prepared = await execution.prepareOperation(request, accepted(admissionRevision), signal)
  if (!prepared.ok) throw new Error(`test Agent Run was not prepared: ${prepared.reason}`)
  const persistence = operationPersistence(execution)
  persistence.replace(async (record) => {
    await persistence.original(record)
    if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'agent-run'
      && record.effectPlan.publication === 'not-started') {
      throw new Error('captured planned Agent Run')
    }
  })
  await expect(execution.startOperation(
    prepared.preparation.operation,
    prepared.acceptance,
    signal,
  )).rejects.toThrow('captured planned Agent Run')
  persistence.restore()
  return prepared
}

function liveAgentRunHandles(execution: LocalSakiHostExecution) {
  return (execution as unknown as {
    liveAgentRuns: Map<typeof SESSION_ID, { readonly agent: Agent; dispose: () => Promise<void> }>
  }).liveAgentRuns
}

function scriptAgentRegistryReads(harness: AgentRunHarness, reads: readonly (Agent | undefined)[]) {
  const get = harness.context.agents.get.bind(harness.context.agents)
  let index = 0
  return vi.spyOn(harness.context.agents, 'get').mockImplementation(sessionId =>
    index < reads.length ? reads[index++] : get(sessionId))
}

function changeSessionIdentityOnRead(harness: AgentRunHarness, targetRead: number): void {
  const readFrom = harness.context.sessionPersistence.readFrom.bind(harness.context.sessionPersistence)
  let reads = 0
  vi.spyOn(harness.context.sessionPersistence, 'readFrom').mockImplementation(async (...args) => {
    const persisted = await readFrom(...args)
    reads += 1
    return reads === targetRead
      ? { ...persisted, meta: { ...persisted.meta, cwd: join(tmpdir(), 'saki-changed-between-inspections') } }
      : persisted
  })
}

function replaceGitRunner(execution: LocalSakiHostExecution, failure: unknown): { readonly restore: () => void } {
  const target = execution as unknown as { git: GitRunner }
  const original = target.git
  target.git = {
    run: async () => { throw failure },
  } as unknown as GitRunner
  return { restore: () => { target.git = original } }
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-agent-run-repository-'))
  roots.push(root)
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Saki Test')
  await git(root, 'config', 'user.email', 'saki@example.invalid')
  await writeFile(join(root, 'tracked.txt'), 'base\n')
  await git(root, 'add', '--', 'tracked.txt')
  await git(root, 'commit', '-m', 'base')
  return root
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', args, { cwd, windowsHide: true })
}
