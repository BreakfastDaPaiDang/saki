/** Cross-record ownership and crash-prefix checks for Work Session succession. */

import { isDeepStrictEqual } from 'node:util'
import type { ControlIntentActor } from './spec.ts'
import type { AgentOperationIntentTable, AgentRunTable, WorkAssignmentTable, WorkSessionTable } from './agent-operations.ts'
import type { RunModelSwitchIntentTable } from './run-model-switch.ts'
import { runModelSwitchIntentRecordSchema } from './run-model-switch-spec.ts'
import type { RunModelSwitchIntentRecord } from './run-model-switch-spec.ts'

type ReadTable<T> = Pick<T, Extract<keyof T, 'get' | 'entries'>>

/**
 * Check exact switch ownership, ordered Session membership, and interrupted publication prefixes.
 * @param tables - complete switch, Run, Session, Assignment, and original dispatch Intent records.
 * @param validateActor - historical operator reference validator.
 * @returns parsed model-switch Intents for account and cross-family validation.
 */
export function validateRunModelSwitchRecords(tables: {
  readonly intents: ReadTable<RunModelSwitchIntentTable>
  readonly runs: ReadTable<AgentRunTable>
  readonly sessions: ReadTable<WorkSessionTable>
  readonly assignments: ReadTable<WorkAssignmentTable>
  readonly origins: ReadTable<AgentOperationIntentTable>
}, validateActor: (actor: ControlIntentActor) => void): readonly RunModelSwitchIntentRecord[] {
  const records = [...tables.intents.entries()].map(([key, value]) => {
    const record = runModelSwitchIntentRecordSchema.parse(value)
    const source = tables.runs.get(record.request.expectedAgentRunId)
    const session = tables.sessions.get(record.request.workSessionId)
    const target = record.hostRequest.target
    const suffix = record.id.slice('intent-'.length)
    if (key !== record.id || record.id !== record.request.intentId || source === undefined || session === undefined
      || session.agentRunIds.indexOf(source.id) !== record.request.expectedWorkSessionRevision
      || source.projectId !== record.request.projectId || source.workSessionId !== session.id
      || record.hostRequest.workSessionId !== session.id
      || !isDeepStrictEqual(record.hostRequest.source, { agentRunId: source.id, sessionId: source.sessionId, profile: source.profile })
      || target.agentRunId !== `agent-run-${suffix}` || target.sessionId !== `session-${suffix}`
      || target.profile.id !== `agent-profile-${suffix}`
      || target.profile.version !== source.profile.version + 1 || target.profile.agentPresetId !== source.profile.agentPresetId
      || target.profile.modelRoute.provider !== record.accountRoute.provider
      || target.profile.modelRoute.model !== record.request.selection.model
      || !isDeepStrictEqual(record.accountRoute.selection, record.request.selection) || record.updatedAt < record.createdAt) {
      throw new Error('Model switch identities or account attribution conflict')
    }
    validateActor(record.actor)
    const assignment = tables.assignments.get(source.assignmentId)
    const origin = tables.origins.get(source.intentId)
    if (assignment?.ownerPrincipalId !== record.actor.principalId || assignment.primaryWorkSessionId !== session.id
      || origin === undefined || origin.assignmentId !== source.assignmentId
      || record.hostRequest.binding.id !== source.bindingId
      || record.hostRequest.binding.revision !== origin.projectContext.bindingRevision
      || record.hostRequest.binding.hostId !== origin.hostRequest.expected.binding.hostId) {
      throw new Error('Model switch Assignment or resource ownership conflicts')
    }
    const run = tables.runs.get(target.agentRunId)
    if (run !== undefined && (run.schemaVersion !== 3 || run.forkIntentId !== record.id || run.sourceAgentRunId !== source.id
      || run.intentId !== source.intentId || run.assignmentId !== source.assignmentId || run.workSessionId !== session.id
      || run.projectId !== source.projectId || run.workItemId !== source.workItemId || run.bindingId !== source.bindingId
      || run.sessionId !== target.sessionId || !isDeepStrictEqual(run.profile, target.profile)
      || !isDeepStrictEqual(run.accountRoute, record.accountRoute) || run.createdAt !== record.createdAt || record.plan === undefined)) {
      throw new Error('Model switch successor Run differs from its owning Intent')
    }
    const included = session.agentRunIds.includes(target.agentRunId)
    if ((included && run === undefined) || (record.state === 'completed' && (record.plan === undefined || !included))
      || (record.state === 'failed' && (record.plan !== undefined || run !== undefined || included))) {
      throw new Error('Model switch publication evidence conflicts with its state')
    }
    return record
  })
  for (const [, run] of tables.runs.entries()) {
    if (run.schemaVersion === 3 && tables.intents.get(run.forkIntentId)?.hostRequest.target.agentRunId !== run.id) {
      throw new Error('Forked Run has no exact owning model switch')
    }
  }
  for (const [, session] of tables.sessions.entries()) {
    const assignment = tables.assignments.get(session.assignmentId)
    const origin = tables.origins.get(session.intentId)
    if (origin === undefined || session.agentRunIds[0] !== origin.agentRunId) throw new Error('Work Session has no initial Run')
    for (const [index, id] of session.agentRunIds.entries()) {
      if (index === 0) continue
      const run = tables.runs.get(id)
      const record = run?.schemaVersion === 3 ? tables.intents.get(run.forkIntentId) : undefined
      if (record === undefined || record.hostRequest.source.agentRunId !== session.agentRunIds[index - 1]
        || record.request.expectedWorkSessionRevision !== index - 1 || record.state === 'failed'
        || (index < session.agentRunIds.length - 1 && record.state !== 'completed')) {
        throw new Error('Work Session model-switch sequence conflicts')
      }
    }
    const pending = records.filter(record => record.request.workSessionId === session.id
      && (record.state === 'accepted' || record.state === 'reconciliation-required'))
    if (pending.length > 1 || (pending[0] !== undefined
      && ![session.agentRunIds.at(-1), session.agentRunIds.at(-2)].includes(pending[0].hostRequest.source.agentRunId))) {
      throw new Error('Work Session has conflicting unfinished model switches')
    }
    if (session.state === 'open' && session.revision !== session.agentRunIds.length - 1) throw new Error('Work Session revision differs from its model-switch sequence')
    if (assignment !== undefined && assignment.agentRunId !== session.agentRunIds.at(-1)
      && !(pending[0] !== undefined && assignment.agentRunId === pending[0].hostRequest.source.agentRunId
        && session.agentRunIds.at(-1) === pending[0].hostRequest.target.agentRunId)) {
      throw new Error('Work Assignment current Run differs from its Work Session')
    }
  }
  return records
}
