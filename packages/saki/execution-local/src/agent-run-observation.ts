/** Read-only Run accounting and current owner-scoped Terminal evidence. */
import { randomUUID } from 'node:crypto'
import { symbols } from '@deepseek-ai/cordis'
import { foldConsumedWork, type Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-terminal'
import type {
  AgentRunObservation,
  AgentRunSessionActivity,
  AgentRunSessionObservation,
  AgentRunTerminalObservation,
  AgentRunTerminalSelection,
  SakiRunTerminalId,
} from '@breakfastdapaidang/saki-execution'
import { inspectDurableSession, type LocalAgentRunDependencies } from './agent-run.ts'
import type { LocalHostAgentRunOperationRecord } from './operation-state.ts'

/** Deployment-selected read bounds within the Run wire protocol's fixed maxima. */
export interface RunObservationLimits {
  readonly runTerminalMaxItems: number
  readonly runTerminalPageLines: number
  readonly runTerminalMaxChars: number
}

type Dependencies = Pick<LocalAgentRunDependencies, 'agents' | 'handles' | 'sessions' | 'sessionPersistence'> & {
  readonly terminalGenerations: WeakMap<object, string>
}

/**
 * Read Session history without activating its Agent, then sample current PTYs independently.
 * @param dependencies - exact Provider-owned Session readers and live handles.
 * @param record - validated StartAgentRun operation retaining the Session's original identity.
 * @param terminal - optional selection scoped to that same live Agent.
 * @param limits - complete Terminal response bounds.
 * @param signal - caller and Provider lifetime.
 * @returns safe observations; unavailable history never becomes a successful Run.
 */
export async function observeLocalAgentRun(
  dependencies: Dependencies,
  record: LocalHostAgentRunOperationRecord,
  terminal: AgentRunTerminalSelection | null,
  limits: RunObservationLimits,
  signal: AbortSignal,
): Promise<AgentRunObservation> {
  const sessionId = record.request.run.sessionId
  let session: AgentRunSessionObservation
  try {
    const evidence = await inspectDurableSession(dependencies, sessionId, signal)
    signal.throwIfAborted()
    const live = dependencies.agents.get(sessionId)
    if (evidence.kind === 'conflict'
      || live !== undefined && dependencies.handles.get(sessionId)?.agent !== live
      || evidence.kind === 'present' && (evidence.meta.cwd !== record.request.expected.binding.expectedInspection.trusted.canonicalWorktreePath
        || evidence.meta.agentPreset !== record.request.run.profile.agentPresetId)) {
      session = { state: 'unavailable', reason: 'evidence-conflict' }
    } else if (evidence.kind === 'absent') {
      session = { state: 'unavailable', reason: 'missing' }
    } else {
      const runtime = live?.status ?? 'not-live'
      session = { state: 'confirmed', runtime, activity: sessionActivity(evidence.events, runtime) }
    }
  } catch {
    signal.throwIfAborted()
    session = { state: 'unavailable', reason: 'read-failed' }
  }
  const live = dependencies.agents.get(sessionId)
  const owner = live !== undefined && dependencies.handles.get(sessionId)?.agent === live ? live : undefined
  return { observedAt: Date.now(), session, terminals: terminalObservation(owner, terminal, limits, dependencies.terminalGenerations) }
}

function sessionActivity(events: readonly SessionEvent[], runtime: 'running' | 'idle' | 'not-live'): AgentRunSessionActivity {
  const boundary = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (runtime === 'running' || boundary?.type === 'turn/start') {
    return { state: runtime === 'not-live' ? 'interrupted' : 'running', turn: boundary?.data.turn ?? null, endedAt: null }
  }
  const consumed = foldConsumedWork(events)
  if (consumed.droppedUnrun) return { state: 'canceled', turn: null, endedAt: null }
  const end = consumed.end
  if (end === undefined) return { state: 'idle', turn: null, endedAt: null }
  let state: AgentRunSessionActivity['state']
  switch (end.data.reason.kind) {
    case 'completed': state = 'succeeded'; break
    case 'error': state = 'failed'; break
    case 'aborted': state = 'canceled'; break
    case 'interrupted': state = 'interrupted'; break
    case 'blocked': state = 'blocked'; break
    case 'max-tokens': state = 'limited'; break
    /* v8 ignore next -- Turn endings are merge-extensible; an unnameable ending is not evidence of success. */
    default: state = 'failed'
  }
  return { state, turn: end.data.turn, endedAt: end.time }
}

function terminalObservation(
  owner: Agent | undefined, selection: AgentRunTerminalSelection | null,
  limits: RunObservationLimits, generations: WeakMap<object, string>,
): AgentRunTerminalObservation {
  if (owner === undefined) return { state: 'unavailable', reason: 'owner-not-live' }
  const terminals = owner.ctx.get('terminals')
  if (terminals === undefined) return { state: 'unavailable', reason: 'provider-unavailable' }
  try {
    // PTY ids restart at one with a new registry. Cordis receivers rewrap a service on each read.
    const origin = (Reflect.get(terminals, symbols.original) as object | undefined) ?? terminals
    let generation = generations.get(origin)
    if (generation === undefined) { generation = randomUUID(); generations.set(origin, generation) }
    const idOf = (id: string) => `terminal-${generation}:${id}` as SakiRunTerminalId
    const all = terminals.list(owner)
    const selected = selection === null ? undefined : all.find(item => idOf(item.sessionId) === selection.id)
    const shown = all.slice(0, limits.runTerminalMaxItems)
    if (selected !== undefined && !shown.includes(selected)) shown[shown.length - 1] = selected
    const items = shown.map(item => ({
      id: idOf(item.sessionId),
      name: item.name === undefined ? null : displayLabel(item.name),
      type: displayLabel(item.type),
      process: item.status.kind === 'running' ? { state: 'running' as const }
        : { state: 'exited' as const, exitCode: item.status.exitCode, signal: item.status.signal },
    }))
    if (selection === null) return { state: 'confirmed', items, more: all.length > shown.length, selected: null }
    if (selected === undefined) return { state: 'confirmed', items, more: all.length > shown.length, selected: { state: 'missing', id: selection.id } }
    const read = terminals.read(owner, selected.sessionId, { offset: selection.offset, count: limits.runTerminalPageLines })
    return { state: 'confirmed', items, more: all.length > shown.length, selected: {
      state: 'confirmed', id: selection.id, text: read.text.slice(-limits.runTerminalMaxChars).toWellFormed(),
      totalLines: read.totalLines, lineBegin: read.lineBegin, lineEnd: read.lineEnd,
      truncated: read.truncated || read.text.length > limits.runTerminalMaxChars,
    } }
  } catch {
    return { state: 'unavailable', reason: 'read-failed' }
  }
}

function displayLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 256).toWellFormed()
}
