/** Model-idle Run succession through durable Session fork evidence. */

import { addAbortListener } from 'node:events'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import type { AgentRunForkPlan, ForkAgentRunRequest } from '@breakfastdapaidang/saki-execution'
import { inspectDurableSession, localAgentRunSetup, verifyLocalAgentRunBinding } from './agent-run.ts'
import type { LocalAgentRunDependencies } from './agent-run.ts'

/**
 * Retain a quiescent history cut, publish its exact successor, and retire the source runtime.
 * @param dependencies - Local Host-owned Agent and Session capabilities.
 * @param request - immutable source, successor, profile, and workspace identities.
 * @param retained - exact previously acknowledged cut, if preparation already committed.
 * @param retainPlan - Consumer transaction that durably owns the cut before publication.
 * @param signal - required operation lifetime.
 * @returns the retained cut after successor persistence and source teardown settle.
 */
export async function forkLocalAgentRun(
  dependencies: LocalAgentRunDependencies,
  request: ForkAgentRunRequest,
  retained: AgentRunForkPlan | undefined,
  retainPlan: (plan: AgentRunForkPlan) => Promise<void>,
  signal: AbortSignal,
): Promise<AgentRunForkPlan> {
  await verifyLocalAgentRunBinding(dependencies, request.binding, signal)
  const sourceHandle = dependencies.handles.get(request.source.sessionId)
  const registered = dependencies.agents.get(request.source.sessionId)
  if (registered !== sourceHandle?.agent) throw new Error('Run fork source has conflicting runtime ownership')
  if (retained === undefined && sourceHandle === undefined) throw new Error('Run fork source is not live')
  if (sourceHandle !== undefined && (sourceHandle.agent.options.provider !== request.source.profile.modelRoute.provider
    || sourceHandle.agent.options.model !== request.source.profile.modelRoute.model)) {
    throw new Error('Run fork source profile conflicts')
  }
  let retirement: Promise<PromiseSettledResult<void>[]> | undefined
  const publish = async (): Promise<AgentRunForkPlan> => {
    const source = await inspectDurableSession(dependencies, request.source.sessionId, signal)
    const cwd = request.binding.expectedInspection.trusted.canonicalWorktreePath
    if (source.kind !== 'present' || source.meta.cwd !== cwd
      || source.meta.agentPreset !== request.source.profile.agentPresetId) throw new Error('Run fork source evidence conflicts')
    assertQuiescent(sourceHandle)
    const plan = retained ?? { inheritedEventCount: source.events.length, historyDigest: historyDigest(source.events) }
    const seed = source.events.slice(0, plan.inheritedEventCount)
    if (seed.length !== plan.inheritedEventCount || historyDigest(seed) !== plan.historyDigest
      || !seed.some(event => event.type === 'turn/end')) throw new Error('Run fork history differs from its retained cut')
    if (retained === undefined) await retainPlan(plan)
    signal.throwIfAborted()
    await verifyLocalAgentRunBinding(dependencies, request.binding, signal)
    const target = await inspectDurableSession(dependencies, request.target.sessionId, signal)
    if (target.kind === 'absent' && source.events.length !== plan.inheritedEventCount) {
      throw new Error('Run fork source advanced beyond its retained history cut')
    }
    if (target.kind === 'conflict' || (target.kind === 'present' && (target.meta.cwd !== cwd
      || target.meta.agentPreset !== request.target.profile.agentPresetId
      || target.meta.parentSession !== request.source.sessionId
      || target.inheritedEventCount !== plan.inheritedEventCount
      || historyDigest(target.events.slice(0, plan.inheritedEventCount)) !== plan.historyDigest))) {
      throw new Error('Run fork successor evidence conflicts')
    }
    const retire = (): void => {
      assertQuiescent(sourceHandle)
      if (sourceHandle !== undefined) {
        if (sourceHandle.agent.session.seq !== plan.inheritedEventCount) throw new Error('Run fork source changed after preparation')
        retirement = Promise.allSettled([sourceHandle.dispose()])
      }
    }
    let handle = dependencies.handles.get(request.target.sessionId)
    if (handle === undefined) {
      const setup = localAgentRunSetup(dependencies, request.target.profile, request.target.agentRunId)
      const options = {
        agentOptions: { provider: request.target.profile.modelRoute.provider, model: request.target.profile.modelRoute.model },
        setup: async (...args: Parameters<typeof setup>) => {
          const prepared = await setup(...args)
          return { commit: () => { signal.throwIfAborted(); prepared?.commit(); retire() } }
        },
        signal,
      }
      handle = target.kind === 'present'
        ? await dependencies.agents.resume({ ...options, resumeSessionId: request.target.sessionId })
        : await dependencies.agents.create({ ...options, sessionId: request.target.sessionId, seed,
          inheritedEventCount: SessionLogOffset(plan.inheritedEventCount),
          meta: { cwd, agentPreset: request.target.profile.agentPresetId, parentSession: request.source.sessionId, isSeeded: true } })
      dependencies.handles.set(request.target.sessionId, handle)
    } else {
      if (dependencies.agents.get(request.target.sessionId) !== handle.agent
        || handle.agent.options.provider !== request.target.profile.modelRoute.provider
        || handle.agent.options.model !== request.target.profile.modelRoute.model) throw new Error('Run fork successor runtime conflicts')
      retire()
    }
    await dependencies.sessions.flush(handle.agent.session)
    signal.throwIfAborted()
    return plan
  }
  try {
    if (sourceHandle === undefined) return await publish()
    const aborted = Promise.withResolvers<never>()
    using _subscription = addAbortListener(signal, () => { aborted.reject(signal.reason) })
    await Promise.race([sourceHandle.agent.whenIdle(), aborted.promise])
    signal.throwIfAborted()
    return await sourceHandle.agent.runMaintenance(publish)
  } finally {
    if (retirement !== undefined) {
      const [result] = await retirement
      if (result?.status === 'rejected') throw result.reason
      if (dependencies.handles.get(request.source.sessionId) === sourceHandle) dependencies.handles.delete(request.source.sessionId)
    }
  }
}

function assertQuiescent(handle: AgentHandle | undefined): void {
  if (handle !== undefined && (handle.agent.inbox.nextTurn.length > 0 || handle.agent.inbox.nextStep.length > 0)) {
    throw new Error('Run fork source has pending input')
  }
}

function historyDigest(events: readonly SessionEvent[]): string {
  return canonicalDigest('saki/agent-run-fork-history/v1', events)
}
