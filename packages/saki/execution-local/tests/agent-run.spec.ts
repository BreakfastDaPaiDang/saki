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
  type SakiExecutionDispatchId,
  type SakiHostId,
  type SakiResourceBindingId,
  type SakiWorkSessionId,
  type StartAgentRunHostOperationRequest,
  type StartAgentRunInputMessage,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalSakiHostExecution, {
  type Config,
  type LocalHostOperationRecord,
  sakiHostExecutionDomainSpec,
} from '../src/index.ts'
import { disposeLocalAgentRuns, waitForInputRecord } from '../src/agent-run.ts'

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

const CONFIG: Required<Config> = {
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
  }, 30_000)

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
      schemaVersion: 2,
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
): Promise<void> {
  const persisted = Session.create(SESSION_ID, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SESSION_ID,
    createdAt: Date.now(),
    cwd: binding.expectedInspection.trusted.canonicalWorktreePath,
    agentPreset: request.run.profile.agentPresetId,
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
