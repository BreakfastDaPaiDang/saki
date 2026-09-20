/** Exact Work Session succession without changing prior Run configuration. */

import { isDeepStrictEqual } from 'node:util'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SakiHostExecution, SessionId } from '@breakfastdapaidang/saki-execution'
import type { ControlIntentActor } from './spec.ts'
import type { AgentOperationIntentTable, AgentRunTable, WorkAssignmentTable, WorkSessionTable } from './agent-operations.ts'
import type { DevelopmentProjects } from './projects.ts'
import type { ModelSupply } from './model-supply.ts'
import type { SakiControlIntentId } from './types.ts'
import { enqueueKeyedOperation } from './keyed-operation.ts'
import { forkedAgentRunRecordSchema, runModelSwitchIntentRecordSchema } from './run-model-switch-spec.ts'
import type { RunModelSwitchIntentRecord, SwitchWorkSessionModelIntent, SwitchWorkSessionModelResult } from './run-model-switch-spec.ts'

/** Durable model switches, including accepted history cuts and publication acknowledgements. */
export type RunModelSwitchIntentTable = KvTable<SakiControlIntentId, RunModelSwitchIntentRecord>

interface Options {
  readonly intents: RunModelSwitchIntentTable
  readonly runs: AgentRunTable
  readonly sessions: WorkSessionTable
  readonly assignments: WorkAssignmentTable
  readonly origins: AgentOperationIntentTable
  readonly projects: Pick<DevelopmentProjects, 'currentActiveBinding'>
  readonly supply: Pick<ModelSupply, 'resolveSelection'>
  readonly execution: Pick<SakiHostExecution, 'forkAgentRun'>
  readonly authorityCurrent: (actor: ControlIntentActor) => boolean
  readonly notifyChanged: () => void
  readonly lifetime: AbortSignal
}

/** One ordered sequence of immutable model configurations per Work Session. */
export class RunModelSwitches {
  private readonly operations = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly options: Options) {}

  /**
   * Classify generic Session control without asynchronous admission gaps.
   * @param sessionId - physical Session addressed by a generic command.
   * @returns current ownership, historical ownership, or an unfinished switch; undefined means unowned.
   */
  sessionControlState(sessionId: SessionId): 'owned' | 'historical' | 'transitioning' | undefined {
    if ([...this.options.intents.entries()].some(([, intent]) => (intent.state === 'accepted' || intent.state === 'reconciliation-required')
      && (intent.hostRequest.source.sessionId === sessionId || intent.hostRequest.target.sessionId === sessionId))) return 'transitioning'
    const run = [...this.options.runs.entries()].find(([, candidate]) => candidate.sessionId === sessionId)?.[1]
    if (run === undefined) return undefined
    return this.options.assignments.get(run.assignmentId)?.agentRunId === run.id ? 'owned' : 'historical'
  }

  /**
   * Capture one account choice and publish its successor after the source becomes quiescent.
   * @param request - exact revision-fenced selection.
   * @param actor - authenticated operator that owns the Work Assignment.
   * @param signal - admission cancellation before durable acceptance.
   * @returns an exact replayable receipt or a closed rejection.
   */
  async submit(
    request: SwitchWorkSessionModelIntent, actor: ControlIntentActor, signal: AbortSignal,
  ): Promise<SwitchWorkSessionModelResult> {
    return await enqueueKeyedOperation(this.operations, request.workSessionId, async () => {
      signal.throwIfAborted()
      if (this.closed || this.options.lifetime.aborted) return { ok: false, reason: 'unavailable' }
      if (!this.options.authorityCurrent(actor)) return { ok: false, reason: 'denied' }
      const retained = this.options.intents.get(request.intentId)
      if (retained !== undefined) {
        if (!isDeepStrictEqual(retained.request, request) || !isDeepStrictEqual(retained.actor, actor)) return { ok: false, reason: 'conflict' }
        return await this.finish(retained)
      }
      const session = this.options.sessions.get(request.workSessionId)
      const source = this.options.runs.get(request.expectedAgentRunId)
      const assignment = session === undefined ? undefined : this.options.assignments.get(session.assignmentId)
      if (session?.state !== 'open' || source?.state !== 'running' || session.projectId !== request.projectId
        || source.workSessionId !== session.id || session.revision !== request.expectedWorkSessionRevision
        || assignment?.state !== 'active' || assignment.agentRunId !== source.id || assignment.ownerPrincipalId !== actor.principalId
        || session.agentRunIds.length >= 32 || this.sessionControlState(source.sessionId as SessionId) !== 'owned') {
        return { ok: false, reason: 'conflict' }
      }
      const origin = this.options.origins.get(source.intentId)
      const current = this.options.projects.currentActiveBinding(request.projectId)
      if (origin === undefined || typeof current === 'string' || current.binding.id !== source.bindingId
        || current.binding.revision !== origin.projectContext.bindingRevision) return { ok: false, reason: 'unavailable' }
      let accountRoute
      try { accountRoute = await this.options.supply.resolveSelection(request.selection, signal) }
      catch { signal.throwIfAborted(); return { ok: false, reason: 'unavailable' } }
      signal.throwIfAborted()
      if (!this.options.authorityCurrent(actor)) return { ok: false, reason: 'denied' }
      const suffix = request.intentId.slice('intent-'.length)
      const now = Date.now()
      const record = runModelSwitchIntentRecordSchema.parse({ schemaVersion: 1, id: request.intentId, request, actor, accountRoute,
        hostRequest: { binding: current.binding, workSessionId: session.id,
          source: { agentRunId: source.id, sessionId: source.sessionId, profile: source.profile },
          target: { agentRunId: `agent-run-${suffix}`, sessionId: `session-${suffix}`,
            profile: { id: `agent-profile-${suffix}`, version: source.profile.version + 1,
              agentPresetId: source.profile.agentPresetId,
              modelRoute: { provider: accountRoute.provider, model: request.selection.model } } } },
        state: 'accepted', createdAt: now, updatedAt: now })
      await this.options.intents.put(record.id, record)
      this.options.notifyChanged()
      return await this.finish(record)
    })
  }

  /** Restore current completed forks before ordinary Run recovery and Client readiness. */
  async restoreCompleted(): Promise<void> {
    for (const [, record] of this.options.intents.entries()) {
      if (record.state !== 'completed') continue
      const session = this.options.sessions.get(record.request.workSessionId)
      if (session === undefined
        || this.options.assignments.get(session.assignmentId)?.agentRunId !== record.hostRequest.target.agentRunId) continue
      if (record.plan === undefined) throw new Error('Completed model switch has no retained history cut')
      await this.options.execution.forkAgentRun(record.hostRequest, record.plan, () => {
        throw new Error('Completed model switch attempted to prepare a different history cut')
      }, this.options.lifetime)
    }
  }

  /** Repair interrupted switch acknowledgement after source Run recovery. */
  async recover(): Promise<void> {
    for (const [, record] of this.options.intents.entries()) {
      if (record.state === 'accepted' || record.state === 'reconciliation-required') await this.finish(record)
    }
  }

  /** Reject fresh work and await every accepted switch's settlement. */
  async dispose(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.operations.values())
  }

  private async finish(initial: RunModelSwitchIntentRecord): Promise<SwitchWorkSessionModelResult> {
    let record = initial
    if (record.state === 'accepted' || record.state === 'reconciliation-required') {
      try {
        if (record.plan === undefined && !this.options.authorityCurrent(record.actor)) throw new Error('Model switch authority changed')
        const plan = await this.options.execution.forkAgentRun(record.hostRequest, record.plan, async (plan) => {
          const currentRoute = await this.options.supply.resolveSelection(record.request.selection, this.options.lifetime)
          if (!isDeepStrictEqual(currentRoute, record.accountRoute)) throw new Error('Selected account route changed')
          if (!this.options.authorityCurrent(record.actor)) throw new Error('Model switch authority changed')
          if (this.options.runs.get(record.request.expectedAgentRunId)?.state !== 'running') throw new Error('Model switch source needs attention')
          record = { ...record, plan, updatedAt: Math.max(record.updatedAt, Date.now()) }
          await this.options.intents.put(record.id, record)
        }, this.options.lifetime)
        if (!isDeepStrictEqual(plan, record.plan)) throw new Error('Model switch history acknowledgement differs')
        await this.publish(record)
        record = { ...record, state: 'completed', updatedAt: Math.max(record.updatedAt, Date.now()) }
        await this.options.intents.put(record.id, record)
      } catch {
        // Provider and storage failures retain exact evidence without exposing their diagnostics.
        record = this.options.intents.get(record.id) ?? record
        if (record.state !== 'completed') {
          record = { ...record, state: record.plan === undefined ? 'failed' : 'reconciliation-required', updatedAt: Math.max(record.updatedAt, Date.now()) }
          await this.options.intents.put(record.id, record)
        }
      }
      this.options.notifyChanged()
    }
    return { ok: true, receipt: { intentId: record.id, state: record.state,
      agentRunId: record.hostRequest.target.agentRunId, sessionId: record.hostRequest.target.sessionId } }
  }

  private async publish(record: RunModelSwitchIntentRecord): Promise<void> {
    const source = this.options.runs.get(record.request.expectedAgentRunId)
    if (source === undefined) throw new Error('Model switch source Run is absent')
    const target = record.hostRequest.target
    const retained = this.options.runs.get(target.agentRunId)
    if (retained === undefined) {
      await this.options.runs.put(target.agentRunId, forkedAgentRunRecordSchema.parse({
        id: target.agentRunId, schemaVersion: 3, revision: 0, intentId: source.intentId,
        assignmentId: source.assignmentId, workSessionId: source.workSessionId, projectId: source.projectId,
        workItemId: source.workItemId, bindingId: source.bindingId, profile: target.profile, sessionId: target.sessionId,
        forkIntentId: record.id, sourceAgentRunId: source.id, accountRoute: record.accountRoute,
        dispatchIds: [], state: 'running', createdAt: record.createdAt, updatedAt: record.createdAt,
      }))
    } else if (retained.schemaVersion !== 3 || retained.forkIntentId !== record.id) throw new Error('Model switch successor identity conflicts')
    await this.options.sessions.update(source.workSessionId, (session) => {
      if (session.agentRunIds.includes(target.agentRunId)) return session
      if (session.revision !== record.request.expectedWorkSessionRevision || session.agentRunIds.at(-1) !== source.id) {
        throw new Error('Model switch Work Session changed')
      }
      return { ...session, revision: session.revision + 1, agentRunIds: [...session.agentRunIds, target.agentRunId],
        updatedAt: Math.max(session.updatedAt, Date.now()) }
    })
    await this.options.assignments.update(source.assignmentId, (assignment) => {
      if (assignment.agentRunId === target.agentRunId) return assignment
      if (assignment.agentRunId !== source.id) throw new Error('Model switch Assignment changed')
      return { ...assignment, revision: assignment.revision + 1, agentRunId: target.agentRunId,
        updatedAt: Math.max(assignment.updatedAt, Date.now()) }
    })
  }
}
