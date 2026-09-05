/** Crash-safe exact-input delivery for Local Saki Agent Run Host Operations. */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentRegistry,
  type PreStepDecision,
} from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type {
  HostOperationCancellationReason,
  HostOperationFailure,
  HostOperationSnapshot,
  SakiAgentRunId,
  StartAgentRunInputMessage,
} from '@breakfastdapaidang/saki-execution'
import {
  NoEffectMutationError,
  RetryableMutationError,
  verifyFrozenHostOperationWorld,
  type LocalHostWorldVerificationDependencies,
} from './git-mutation.ts'
import {
  hostOperationSnapshotCore,
  localHostAgentRunResultFor,
  type LocalHostAgentRunOperationRecord,
} from './operation-state.ts'

interface SakiAgentRunWakeMessageSource {
  readonly kind: 'saki-agent-run-wake'
  readonly agentRunId: SakiAgentRunId
  readonly ordinal: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Model-invisible wake used to claim one already-durable Saki Agent Run input. */
    readonly 'saki-agent-run-wake': SakiAgentRunWakeMessageSource
  }
}

/** Dependencies owned by the Local Host provider, explicit at the Agent Run seam. */
export interface LocalAgentRunDependencies {
  readonly ctx: Context
  readonly agents: AgentRegistry
  readonly agentPresets: AgentPresets
  readonly sessions: SessionStore
  readonly sessionPersistence: SessionPersistence
  readonly handles: Map<SessionId, AgentHandle>
  readonly world: LocalHostWorldVerificationDependencies
}

/** Durable record writer supplied by the owning Host Operation transaction. */
export type PersistLocalAgentRunOperation = (record: LocalHostAgentRunOperationRecord) => Promise<void>

/** One bounded Agent Run advancement. */
export type LocalAgentRunAdvanceResult =
  | { readonly kind: 'advanced'; readonly record: LocalHostAgentRunOperationRecord }
  | {
    readonly kind: 'retryable'
    readonly reason: 'unavailable'
    readonly record: LocalHostAgentRunOperationRecord
  }

type InputEvidence =
  | { readonly kind: 'absent'; readonly nextWakeOrdinal: number }
  | { readonly kind: 'pending'; readonly nextWakeOrdinal: number }
  | { readonly kind: 'recorded'; readonly nextWakeOrdinal: number }
  | { readonly kind: 'discarded-accounted'; readonly nextWakeOrdinal: number }
  | { readonly kind: 'effect-unknown'; readonly nextWakeOrdinal: number }
  | { readonly kind: 'evidence-conflict'; readonly nextWakeOrdinal: number }

type SessionEvidence =
  | { readonly kind: 'absent' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'present'; readonly events: readonly SessionEvent[]; readonly meta: { readonly cwd?: string; readonly agentPreset?: string } }

/**
 * Advance one accepted StartAgentRun through durable planning, exact input
 * delivery, and success evidence without waiting for model completion. Fresh
 * writable-world evidence is required after Agent acquisition and immediately
 * before either the exact input send or a pending-input wake.
 * @param dependencies - live Agent and Session capabilities.
 * @param initial - accepted, planning, or publishing Agent Run record.
 * @param persist - durable Host Operation writer.
 * @param signal - caller cancellation for this advancement only.
 * @returns a terminal advancement or a retryable availability decision.
 */
export async function advanceLocalAgentRun(
  dependencies: LocalAgentRunDependencies,
  initial: LocalHostAgentRunOperationRecord,
  persist: PersistLocalAgentRunOperation,
  signal: AbortSignal,
): Promise<LocalAgentRunAdvanceResult> {
  let record = initial
  if (record.snapshot.state === 'accepted') {
    record = transitionToPlanning(record)
    await persist(record)
  }
  if (record.snapshot.state === 'planning') {
    record = transitionToPublishing(record)
    await persist(record)
  }
  let worldVerified = false
  if (record.effectPlan?.publication === 'not-started') {
    const verified = await verifyAgentRunWorld(dependencies, record, persist, signal)
    if (verified.kind !== 'verified') return verified.result
    worldVerified = true
    record = withPublication(record, 'attempting')
    await persist(record)
  }
  signal.throwIfAborted()

  const inspected = await inspectDurableSession(dependencies, record.request.run.sessionId, signal)
  if (inspected.kind === 'conflict') {
    const reconciled = await persistReconciledAgentRun(dependencies, record, 'evidence-conflict', persist)
    return { kind: 'advanced', record: reconciled }
  }
  if (inspected.kind === 'present' && !sessionMatchesRequest(inspected, record)) {
    const reconciled = await persistReconciledAgentRun(dependencies, record, 'evidence-conflict', persist)
    return { kind: 'advanced', record: reconciled }
  }
  let evidence: InputEvidence = inspected.kind === 'absent'
    ? { kind: 'absent', nextWakeOrdinal: 0 }
    : classifyInput(inspected.events, record.request.run.input, record.request.run.agentRunId)
  if (evidence.kind === 'recorded') {
    return { kind: 'advanced', record: await persistSucceededAgentRun(record, persist) }
  }
  if (evidence.kind !== 'absent' && evidence.kind !== 'pending') {
    return await reconcileEvidence(dependencies, record, evidence, persist)
  }
  if (evidence.kind === 'pending' || !worldVerified) {
    const verified = await verifyAgentRunWorld(dependencies, record, persist, signal, evidence.kind)
    if (verified.kind !== 'verified') return verified.result
  }

  const acquired = await acquireAgent(dependencies, record, signal)
  if (acquired.kind === 'conflict') {
    const reconciled = await persistReconciledAgentRun(dependencies, record, 'evidence-conflict', persist)
    return { kind: 'advanced', record: reconciled }
  }
  if (acquired.kind === 'unavailable') {
    return { kind: 'retryable', reason: 'unavailable', record }
  }
  const { agent } = acquired.handle
  evidence = classifyInput(agent.session.snapshotEvents(), record.request.run.input, record.request.run.agentRunId)
  if (evidence.kind === 'absent') {
    const verified = await verifyAgentRunWorld(dependencies, record, persist, signal)
    if (verified.kind !== 'verified') return verified.result
    agent.send(freezeMessage(record.request.run.input), 'next-turn', false)
    await dependencies.sessions.flush(agent.session)
    evidence = await inspectDurableInput(dependencies, record, signal)
    if (evidence.kind !== 'pending') {
      return await reconcileEvidence(dependencies, record, evidence, persist)
    }
  }
  if (evidence.kind === 'pending') {
    const verified = await verifyAgentRunWorld(dependencies, record, persist, signal, 'pending')
    if (verified.kind !== 'verified') return verified.result
    await waitForInputRecord(
      agent,
      record.request.run.input,
      signal,
      () => {
        agent.send(agentRunWake(record.request.run.agentRunId, evidence.nextWakeOrdinal), 'next-step', true)
      },
    )
    await dependencies.sessions.flush(agent.session)
    evidence = await inspectDurableInput(dependencies, record, signal)
  }
  if (evidence.kind !== 'recorded') {
    return await reconcileEvidence(dependencies, record, evidence, persist)
  }

  /* v8 ignore else -- applied-recorded publication is persisted only after the append-only Session contains the exact recorded input. */
  if (record.effectPlan?.publication !== 'applied-recorded') {
    record = withPublication(record, 'applied-recorded')
    await persist(record)
  }
  const succeeded = transitionToSuccess(record)
  await persist(succeeded)
  return { kind: 'advanced', record: succeeded }
}

/**
 * Reconcile a persisted Agent Run without creating, resuming, or waking it.
 * @param dependencies - Session persistence and live Agent registry.
 * @param record - current Agent Run record.
 * @param persist - durable Host Operation writer.
 * @param signal - inspection cancellation.
 * @returns the original or reconciled record.
 */
export async function inspectLocalAgentRun(
  dependencies: LocalAgentRunDependencies,
  record: LocalHostAgentRunOperationRecord,
  persist: PersistLocalAgentRunOperation,
  signal: AbortSignal,
): Promise<LocalHostAgentRunOperationRecord> {
  if (record.snapshot.state === 'prepared' || record.snapshot.state === 'accepted'
    || record.snapshot.state === 'planning') {
    return record
  }
  if (record.snapshot.state === 'failed' || record.snapshot.state === 'canceled'
    || record.snapshot.state === 'reconciliation-required') {
    await disposeOwnedAgentRun(dependencies, record.request.run.sessionId)
    return record
  }
  if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') return record
  const session = await inspectDurableSession(dependencies, record.request.run.sessionId, signal)
  if (session.kind === 'conflict') {
    return await persistReconciledAgentRun(dependencies, record, 'evidence-conflict', persist)
  }
  if (session.kind === 'absent') {
    if (record.snapshot.state !== 'succeeded') return record
    return await persistReconciledAgentRun(dependencies, record, 'effect-unknown', persist)
  }
  if (!sessionMatchesRequest(session, record)) {
    return await persistReconciledAgentRun(dependencies, record, 'evidence-conflict', persist)
  }
  const evidence = classifyInput(session.events, record.request.run.input, record.request.run.agentRunId)
  if (record.snapshot.state === 'succeeded' && evidence.kind === 'recorded') return record
  if (record.snapshot.state === 'publishing' && evidence.kind === 'recorded') {
    let next = record
    if (next.effectPlan?.publication !== 'applied-recorded') {
      next = withPublication(next, 'applied-recorded')
      await persist(next)
    }
    const succeeded = transitionToSuccess(next)
    await persist(succeeded)
    return succeeded
  }
  if (record.snapshot.state === 'publishing' && (evidence.kind === 'absent' || evidence.kind === 'pending')) {
    return record
  }
  return await persistReconciledAgentRun(
    dependencies,
    record,
    evidence.kind === 'evidence-conflict' ? 'evidence-conflict' : 'effect-unknown',
    persist,
  )
}

/**
 * Restore one proven succeeded Agent Run as a live Agent handle for its exact
 * Session without waking it.
 * @param dependencies - live Agent and physical Session capabilities.
 * @param record - exact succeeded Host request that authoritatively owns the
 * profile and route; the physical log separately proves Session, preset, and input.
 * @param signal - startup recovery lifetime.
 * @returns after the exact live Agent handle is restored and remains model-idle.
 * @throws when Host evidence, physical Session evidence, or the live Agent conflicts or is unavailable.
 */
export async function resumeSucceededLocalAgentRun(
  dependencies: LocalAgentRunDependencies,
  record: LocalHostAgentRunOperationRecord,
  signal: AbortSignal,
): Promise<void> {
  const physical = await inspectDurableSession(dependencies, record.request.run.sessionId, signal)
  if (physical.kind !== 'present' || !sessionMatchesRequest(physical, record)
    || classifyInput(physical.events, record.request.run.input, record.request.run.agentRunId).kind !== 'recorded') {
    throw new Error(`Saki Agent Run '${record.request.run.agentRunId}' lacks its exact physical Session input`)
  }
  const acquired = await acquireAgent(dependencies, record, signal)
  if (acquired.kind !== 'acquired') {
    throw new Error(`Saki Agent Run '${record.request.run.agentRunId}' Session recovery is ${acquired.kind}`)
  }
  const { agent } = acquired.handle
  if (agent.id !== record.request.run.sessionId
    || agent.options.provider !== record.request.run.profile.modelRoute.provider
    || agent.options.model !== record.request.run.profile.modelRoute.model
    || agent.session.header.cwd !== record.request.expected.binding.expectedInspection.trusted.canonicalWorktreePath
    || agent.session.header.agentPreset !== record.request.run.profile.agentPresetId) {
    await disposeOwnedAgentRun(dependencies, record.request.run.sessionId)
    throw new Error(`Saki Agent Run '${record.request.run.agentRunId}' restored a conflicting Session configuration`)
  }
  const confirmed = await inspectDurableSession(dependencies, record.request.run.sessionId, signal)
  if (confirmed.kind !== 'present' || !sessionMatchesRequest(confirmed, record)
    || classifyInput(confirmed.events, record.request.run.input, record.request.run.agentRunId).kind !== 'recorded') {
    await disposeOwnedAgentRun(dependencies, record.request.run.sessionId)
    throw new Error(`Saki Agent Run '${record.request.run.agentRunId}' lost exact physical Session evidence during recovery`)
  }
}

/**
 * Cancel an Agent Run publication only after its durable not-started plan or
 * physical Session evidence proves that the exact input was never recorded for
 * the model. Any owned Agent handle reaches quiescence before terminal
 * persistence; disposal failure rejects while retaining retryable ownership.
 * @param dependencies - live Agent and Session capabilities.
 * @param initial - current publishing Agent Run record.
 * @param reason - durable control-plane cancellation reason.
 * @param persist - durable Host Operation writer.
 * @param signal - cancellation inspection lifetime.
 * @returns a canceled, succeeded, reconciled, or still-publishing record.
 */
export async function cancelLocalAgentRun(
  dependencies: LocalAgentRunDependencies,
  initial: LocalHostAgentRunOperationRecord,
  reason: HostOperationCancellationReason,
  persist: PersistLocalAgentRunOperation,
  signal: AbortSignal,
): Promise<LocalHostAgentRunOperationRecord> {
  if (initial.effectPlan?.publication === 'not-started') {
    return await persistCanceledAgentRun(dependencies, initial, reason, persist)
  }
  const session = await inspectDurableSession(dependencies, initial.request.run.sessionId, signal)
  if (session.kind === 'conflict') {
    return await persistReconciledAgentRun(dependencies, initial, 'evidence-conflict', persist)
  }
  if (session.kind === 'absent') return await persistCanceledAgentRun(dependencies, initial, reason, persist)
  if (!sessionMatchesRequest(session, initial)) {
    return await persistReconciledAgentRun(dependencies, initial, 'evidence-conflict', persist)
  }
  let evidence = classifyInput(session.events, initial.request.run.input, initial.request.run.agentRunId)
  if (evidence.kind === 'recorded') return await persistSucceededAgentRun(initial, persist)
  if (evidence.kind === 'evidence-conflict' || evidence.kind === 'effect-unknown') {
    return await persistReconciledAgentRun(dependencies, initial, evidence.kind, persist)
  }
  if (evidence.kind === 'pending') {
    const acquired = await acquireAgent(dependencies, initial, signal)
    if (acquired.kind === 'unavailable') return initial
    if (acquired.kind === 'conflict') {
      return await persistReconciledAgentRun(dependencies, initial, 'evidence-conflict', persist)
    }
    const { agent } = acquired.handle
    evidence = classifyInput(agent.session.snapshotEvents(), initial.request.run.input, initial.request.run.agentRunId)
    if (evidence.kind === 'pending') {
      await disposeOwnedAgentRun(dependencies, initial.request.run.sessionId)
      evidence = await inspectDurableInput(dependencies, initial, signal)
    }
  }
  if (evidence.kind === 'absent' || evidence.kind === 'discarded-accounted') {
    return await persistCanceledAgentRun(dependencies, initial, reason, persist)
  }
  if (evidence.kind === 'recorded') return await persistSucceededAgentRun(initial, persist)
  return await persistReconciledAgentRun(
    dependencies,
    initial,
    evidence.kind === 'evidence-conflict' ? 'evidence-conflict' : 'effect-unknown',
    persist,
  )
}

/**
 * Dispose every Agent Handle owned by this Local Host provider to quiescence.
 * @param handles - mutable registry whose current handles are transferred to disposal.
 * @returns after every transferred handle has settled.
 * @throws an AggregateError after all disposals settle when any handle fails.
 */
export async function disposeLocalAgentRuns(handles: Map<SessionId, AgentHandle>): Promise<void> {
  const owned = [...handles.values()]
  handles.clear()
  const disposals = await Promise.allSettled(owned.map(handle => handle.dispose()))
  const failures = disposals.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (failures.length > 0) {
    throw new AggregateError(failures, `Saki Agent Run teardown failed for ${failures.length} Agent Handle(s)`)
  }
}

async function acquireAgent(
  dependencies: LocalAgentRunDependencies,
  record: LocalHostAgentRunOperationRecord,
  signal: AbortSignal,
): Promise<
  | { readonly kind: 'acquired'; readonly handle: AgentHandle }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'unavailable' }
> {
  const { sessionId, profile } = record.request.run
  const retained = dependencies.handles.get(sessionId)
  if (retained !== undefined) {
    if (dependencies.agents.get(sessionId) === retained.agent) return { kind: 'acquired', handle: retained }
    await retained.dispose()
    if (dependencies.handles.get(sessionId) === retained) dependencies.handles.delete(sessionId)
    signal.throwIfAborted()
  }
  if (dependencies.agents.get(sessionId) !== undefined) return { kind: 'conflict' }

  const persisted = await inspectDurableSession(dependencies, sessionId, signal)
  if (persisted.kind === 'conflict') return { kind: 'conflict' }
  if (persisted.kind === 'present' && !sessionMatchesRequest(persisted, record)) return { kind: 'conflict' }
  const setup = async (agentCtx: Context): Promise<void> => {
    await dependencies.agentPresets.mount(agentCtx, profile.agentPresetId)
    installModelSelection(agentCtx, {
      current: { provider: profile.modelRoute.provider, model: profile.modelRoute.model },
      assembled: undefined,
    })
    agentCtx.on('agent/pre-step', async (_request, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        kind: 'enter',
        messages: decision.messages.filter(message => !isWakeForRun(message, record.request.run.agentRunId)),
      }
    })
  }
  try {
    const handle = persisted.kind === 'present'
      ? await dependencies.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: profile.modelRoute.provider, model: profile.modelRoute.model },
        setup,
        signal,
      })
      : await dependencies.agents.create({
        sessionId,
        meta: {
          cwd: record.request.expected.binding.expectedInspection.trusted.canonicalWorktreePath,
          agentPreset: profile.agentPresetId,
        },
        agentOptions: { provider: profile.modelRoute.provider, model: profile.modelRoute.model },
        setup,
        signal,
      })
    dependencies.handles.set(sessionId, handle)
    return { kind: 'acquired', handle }
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (dependencies.agents.get(sessionId) !== undefined) return { kind: 'conflict' }
    dependencies.ctx.logger.warn(`[saki-execution-local] Agent Run '${record.request.run.agentRunId}' is unavailable: ${safeErrorName(error)}`)
    return { kind: 'unavailable' }
  }
}

async function inspectDurableInput(
  dependencies: LocalAgentRunDependencies,
  record: LocalHostAgentRunOperationRecord,
  signal: AbortSignal,
): Promise<InputEvidence> {
  const inspected = await inspectDurableSession(dependencies, record.request.run.sessionId, signal)
  if (inspected.kind === 'conflict') return { kind: 'evidence-conflict', nextWakeOrdinal: 0 }
  if (inspected.kind === 'absent') return { kind: 'effect-unknown', nextWakeOrdinal: 0 }
  if (!sessionMatchesRequest(inspected, record)) return { kind: 'evidence-conflict', nextWakeOrdinal: 0 }
  return classifyInput(inspected.events, record.request.run.input, record.request.run.agentRunId)
}

async function inspectDurableSession(
  dependencies: LocalAgentRunDependencies,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<SessionEvidence> {
  const live = dependencies.agents.get(sessionId)
  if (live !== undefined) {
    if (dependencies.handles.get(sessionId)?.agent !== live) return { kind: 'conflict' }
    await dependencies.sessions.flush(live.session)
    signal.throwIfAborted()
  }
  if (await dependencies.sessionPersistence.stat(sessionId, { signal }) === undefined) return { kind: 'absent' }
  await using handle = await dependencies.sessionPersistence.open(sessionId, 'read', { signal })
  const events = await handle.read(0, undefined, { signal })
  return { kind: 'present', events, meta: handle.header }
}

function sessionMatchesRequest(
  session: Extract<SessionEvidence, { readonly kind: 'present' }>,
  record: LocalHostAgentRunOperationRecord,
): boolean {
  return session.meta.cwd === record.request.expected.binding.expectedInspection.trusted.canonicalWorktreePath
    && session.meta.agentPreset === record.request.run.profile.agentPresetId
}

function classifyInput(
  events: readonly SessionEvent[],
  expected: StartAgentRunInputMessage,
  agentRunId: SakiAgentRunId,
): InputEvidence {
  const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  let inserted = false
  let claimed = false
  let canceled = false
  let recordedCount = 0
  let conflict = false
  let maximumWakeOrdinal = -1
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      const target = event.data.target
      const removed = inbox[target].slice(event.data.start, event.data.start + (event.data.removedCount ?? 0))
      for (const message of removed) {
        if (message.id !== expected.id) continue
        if (!sameMessage(message, expected)) conflict = true
        if (event.data.outcome === 'canceled') canceled = true
        else claimed = true
      }
      for (const message of event.data.inserted) {
        if (message.id === expected.id) {
          inserted = true
          if (!sameMessage(message, expected)) conflict = true
        }
        const wake = wakeOrdinal(message, agentRunId)
        if (wake.kind === 'conflict') conflict = true
        else if (wake.kind === 'wake') maximumWakeOrdinal = Math.max(maximumWakeOrdinal, wake.ordinal)
      }
      inbox[target].splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
      continue
    }
    if (event.type === 'user/message' && event.data.id === expected.id) {
      if (sameMessage(event.data, expected)) recordedCount += 1
      else conflict = true
    }
  }
  const pending = [...inbox['next-turn'], ...inbox['next-step']].filter(message => message.id === expected.id)
  if (pending.some(message => !sameMessage(message, expected)) || pending.length > 1) conflict = true
  const nextWakeOrdinal = maximumWakeOrdinal + 1
  if (conflict || recordedCount > 1 || recordedCount === 1 && (canceled || pending.length > 0)
    || pending.length > 0 && (claimed || canceled)) {
    return { kind: 'evidence-conflict', nextWakeOrdinal }
  }
  if (recordedCount === 1) return { kind: 'recorded', nextWakeOrdinal }
  if (pending.length === 1) return { kind: 'pending', nextWakeOrdinal }
  if (canceled) return { kind: 'discarded-accounted', nextWakeOrdinal }
  if (claimed || inserted) return { kind: 'effect-unknown', nextWakeOrdinal }
  return { kind: 'absent', nextWakeOrdinal }
}

function sameMessage(actual: UserMessage, expected: StartAgentRunInputMessage): boolean {
  return isDeepStrictEqual(actual, expected)
}

function wakeOrdinal(
  message: UserMessage,
  agentRunId: SakiAgentRunId,
): { readonly kind: 'not-wake' } | { readonly kind: 'wake'; readonly ordinal: number } | { readonly kind: 'conflict' } {
  if (message.source.kind !== 'saki-agent-run-wake' || message.source.agentRunId !== agentRunId) {
    return { kind: 'not-wake' }
  }
  const ordinal = message.source.ordinal
  if (!Number.isSafeInteger(ordinal) || ordinal < 0
    || message.id !== wakeMessageId(agentRunId, ordinal)) return { kind: 'conflict' }
  return { kind: 'wake', ordinal }
}

function agentRunWake(agentRunId: SakiAgentRunId, ordinal: number): UserMessage {
  return freezeMessage({
    id: MessageId(wakeMessageId(agentRunId, ordinal)),
    role: 'user',
    content: [{ type: 'text', text: 'Saki Agent Run wake' }],
    source: { kind: 'saki-agent-run-wake', agentRunId, ordinal },
  })
}

function wakeMessageId(agentRunId: SakiAgentRunId, ordinal: number): string {
  return `saki-agent-run-wake:${agentRunId}:${ordinal}`
}

function isWakeForRun(message: UserMessage, agentRunId: SakiAgentRunId): boolean {
  return message.source.kind === 'saki-agent-run-wake' && message.source.agentRunId === agentRunId
}

/**
 * Wait for one exact input to become model-visible after installing race-safe lifecycle listeners.
 * @param agent - Agent whose Session must record the input.
 * @param expected - exact immutable input expected in the Session log.
 * @param signal - cancellation signal for the wait.
 * @param wake - callback that starts or resumes the Agent loop.
 * @returns when the exact input has been recorded.
 */
export async function waitForInputRecord(
  agent: Agent,
  expected: StartAgentRunInputMessage,
  signal: AbortSignal,
  wake: () => void,
): Promise<void> {
  if (agent.session.snapshotEvents().some(event => event.type === 'user/message'
    && event.data.id === expected.id && sameMessage(event.data, expected))) return
  const delivered = Promise.withResolvers<void>()
  const dispose = agent.ctx.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'user/message' || event.data.id !== expected.id) return
    if (sameMessage(event.data, expected)) delivered.resolve()
    else delivered.reject(new Error('Saki Agent Run input identity has conflicting recorded evidence'))
  })
  let wakeIssued = false
  const disposeStatus = agent.ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && wakeIssued && status === 'idle') {
      delivered.reject(new Error('Saki Agent Run became idle before recording its exact input'))
    }
  })
  const onAbort = (): void => { delivered.reject(signal.reason) }
  try {
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      await delivered.promise
    }
    wakeIssued = true
    wake()
    await delivered.promise
  } finally {
    signal.removeEventListener('abort', onAbort)
    dispose()
    disposeStatus()
  }
}

async function reconcileEvidence(
  dependencies: LocalAgentRunDependencies,
  record: LocalHostAgentRunOperationRecord,
  evidence: InputEvidence,
  persist: PersistLocalAgentRunOperation,
): Promise<LocalAgentRunAdvanceResult> {
  const reason = evidence.kind === 'evidence-conflict' ? 'evidence-conflict' : 'effect-unknown'
  const reconciled = await persistReconciledAgentRun(dependencies, record, reason, persist)
  return { kind: 'advanced', record: reconciled }
}

function transitionToPlanning(record: LocalHostAgentRunOperationRecord): LocalHostAgentRunOperationRecord {
  const plannedAt = Date.now()
  return {
    ...record,
    snapshot: {
      ...record.snapshot,
      state: 'planning',
      revision: record.snapshot.revision + 1,
      plannedAt,
      updatedAt: plannedAt,
    } as HostOperationSnapshot<'start-agent-run'>,
  }
}

function transitionToPublishing(record: LocalHostAgentRunOperationRecord): LocalHostAgentRunOperationRecord {
  const publishingAt = Date.now()
  return {
    ...record,
    effectPlan: {
      kind: 'agent-run',
      publication: 'not-started',
      result: localHostAgentRunResultFor(record.request),
    },
    snapshot: {
      ...record.snapshot,
      state: 'publishing',
      revision: record.snapshot.revision + 1,
      effectPlannedAt: publishingAt,
      publishingAt,
      updatedAt: publishingAt,
    } as HostOperationSnapshot<'start-agent-run'>,
  }
}

function withPublication(
  record: LocalHostAgentRunOperationRecord,
  publication: 'attempting' | 'applied-recorded',
): LocalHostAgentRunOperationRecord {
  /* v8 ignore next -- durable publishing records have an Agent Run plan, and the only fresh caller just created it. */
  if (record.effectPlan === undefined) throw new Error('Agent Run publication has no durable plan')
  const updatedAt = Date.now()
  return {
    ...record,
    effectPlan: { ...record.effectPlan, publication },
    snapshot: { ...record.snapshot, revision: record.snapshot.revision + 1, updatedAt },
  }
}

function transitionToSuccess(record: LocalHostAgentRunOperationRecord): LocalHostAgentRunOperationRecord {
  /* v8 ignore next -- the durable schema and private success callers require an Agent Run plan before this transition. */
  if (record.effectPlan === undefined) throw new Error('Agent Run success has no durable plan')
  const completedAt = Date.now()
  return {
    ...record,
    effectPlan: { ...record.effectPlan, publication: 'applied-recorded' },
    snapshot: {
      ...hostOperationSnapshotCore(record.snapshot),
      state: 'succeeded',
      revision: record.snapshot.revision + 1,
      updatedAt: completedAt,
      completedAt,
      result: record.effectPlan.result,
    } as HostOperationSnapshot<'start-agent-run'>,
  }
}

function transitionToCancellation(
  record: LocalHostAgentRunOperationRecord,
  reason: HostOperationCancellationReason,
): LocalHostAgentRunOperationRecord {
  /* v8 ignore next -- cancelLocalAgentRun admits only schema-validated publishing records with an Agent Run plan. */
  if (record.effectPlan === undefined) throw new Error('Agent Run cancellation has no durable plan')
  const completedAt = Date.now()
  return {
    ...record,
    effectPlan: { ...record.effectPlan, publication: 'not-started' },
    snapshot: {
      ...hostOperationSnapshotCore(record.snapshot),
      state: 'canceled',
      revision: record.snapshot.revision + 1,
      updatedAt: completedAt,
      completedAt,
      reason,
      effect: 'none',
    } as HostOperationSnapshot<'start-agent-run'>,
  }
}

function transitionToReconciliation(
  record: LocalHostAgentRunOperationRecord,
  reason: 'effect-unknown' | 'evidence-conflict',
): LocalHostAgentRunOperationRecord {
  const observedAt = Date.now()
  return {
    ...record,
    snapshot: {
      ...hostOperationSnapshotCore(record.snapshot),
      state: 'reconciliation-required',
      revision: record.snapshot.revision + 1,
      updatedAt: observedAt,
      observedAt,
      reason,
    } as HostOperationSnapshot<'start-agent-run'>,
  }
}

function transitionToNoEffectFailure(
  record: LocalHostAgentRunOperationRecord,
  reason: HostOperationFailure['reason'],
): LocalHostAgentRunOperationRecord {
  /* v8 ignore next -- world verification runs only after a schema-validated or freshly created Agent Run plan exists. */
  if (record.effectPlan === undefined) throw new Error('Agent Run failure has no durable plan')
  const completedAt = Date.now()
  return {
    ...record,
    effectPlan: { ...record.effectPlan, publication: 'not-started' },
    snapshot: {
      ...hostOperationSnapshotCore(record.snapshot),
      state: 'failed',
      revision: record.snapshot.revision + 1,
      updatedAt: completedAt,
      completedAt,
      failure: { reason },
      effect: 'none',
    } as HostOperationSnapshot<'start-agent-run'>,
  }
}

async function persistSucceededAgentRun(
  record: LocalHostAgentRunOperationRecord,
  persist: PersistLocalAgentRunOperation,
): Promise<LocalHostAgentRunOperationRecord> {
  let next = record
  if (next.effectPlan?.publication !== 'applied-recorded') {
    next = withPublication(next, 'applied-recorded')
    await persist(next)
  }
  const succeeded = transitionToSuccess(next)
  await persist(succeeded)
  return succeeded
}

async function persistCanceledAgentRun(
  dependencies: LocalAgentRunDependencies,
  record: LocalHostAgentRunOperationRecord,
  reason: HostOperationCancellationReason,
  persist: PersistLocalAgentRunOperation,
): Promise<LocalHostAgentRunOperationRecord> {
  await disposeOwnedAgentRun(dependencies, record.request.run.sessionId)
  const canceled = transitionToCancellation(record, reason)
  await persist(canceled)
  return canceled
}

async function persistReconciledAgentRun(
  dependencies: LocalAgentRunDependencies,
  record: LocalHostAgentRunOperationRecord,
  reason: 'effect-unknown' | 'evidence-conflict',
  persist: PersistLocalAgentRunOperation,
): Promise<LocalHostAgentRunOperationRecord> {
  await disposeOwnedAgentRun(dependencies, record.request.run.sessionId)
  const reconciled = transitionToReconciliation(record, reason)
  await persist(reconciled)
  return reconciled
}

async function verifyAgentRunWorld(
  dependencies: LocalAgentRunDependencies,
  record: LocalHostAgentRunOperationRecord,
  persist: PersistLocalAgentRunOperation,
  signal: AbortSignal,
  evidence: 'absent' | 'pending' = 'absent',
): Promise<
  | { readonly kind: 'verified' }
  | { readonly kind: 'decided'; readonly result: LocalAgentRunAdvanceResult }
> {
  try {
    await verifyFrozenHostOperationWorld(dependencies.world, record.request.expected, signal)
    return { kind: 'verified' }
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (error instanceof RetryableMutationError) {
      return {
        kind: 'decided',
        result: { kind: 'retryable', reason: 'unavailable', record },
      }
    }
    /* v8 ignore next -- world verification emits only classified mutation errors; aborts rethrow on the preceding line. */
    if (!(error instanceof NoEffectMutationError)) throw error
    const decided = evidence === 'pending'
      ? transitionToReconciliation(record, 'effect-unknown')
      : transitionToNoEffectFailure(record, error.reason)
    await disposeOwnedAgentRun(dependencies, record.request.run.sessionId)
    await persist(decided)
    return { kind: 'decided', result: { kind: 'advanced', record: decided } }
  }
}

async function disposeOwnedAgentRun(
  dependencies: LocalAgentRunDependencies,
  sessionId: SessionId,
): Promise<void> {
  const handle = dependencies.handles.get(sessionId)
  const registered = dependencies.agents.get(sessionId)
  if (handle === undefined) {
    if (registered !== undefined) {
      throw new Error(`Saki Agent Run Session '${sessionId}' has a conflicting live Agent`)
    }
    return
  }
  if (registered !== undefined && registered !== handle.agent) {
    throw new Error(`Saki Agent Run Session '${sessionId}' is owned by a conflicting live Agent`)
  }
  if (registered === handle.agent) await handle.dispose()
  if (dependencies.agents.get(sessionId) === handle.agent) {
    throw new Error(`Saki Agent Run Session '${sessionId}' remained live after disposal`)
  }
  if (dependencies.handles.get(sessionId) === handle) dependencies.handles.delete(sessionId)
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name !== '' ? error.name : 'unknown error'
}
