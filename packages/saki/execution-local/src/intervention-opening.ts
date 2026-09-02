/** Durable, read-only Intervention-opening inspection for the Local Host provider. */

import { isDeepStrictEqual } from 'node:util'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type {
  InspectInterventionOpeningRequest,
  InterventionOpeningEvidence,
} from '@breakfastdapaidang/saki-execution'

type OpeningPersistence = Pick<SessionPersistence, 'listSnapshots' | 'readFrom'>

/**
 * Inspect physical Session evidence for one exact `request_intervention` success.
 * @param persistence - detached durable Session reader.
 * @param request - stable call coordinates and exact expected model-visible result.
 * @param signal - required caller lifetime and cancellation.
 * @returns a closed recovery classification without exposing Session state.
 */
export async function inspectLocalInterventionOpening(
  persistence: OpeningPersistence,
  request: InspectInterventionOpeningRequest,
  signal: AbortSignal,
): Promise<InterventionOpeningEvidence> {
  signal.throwIfAborted()
  const snapshots = await persistence.listSnapshots(signal)
  if (!snapshots.some(snapshot => snapshot.header.id === request.sessionId)) return { kind: 'absent' }

  const { events } = await persistence.readFrom(request.sessionId, 0, signal)
  if (!request.expectedToolResult.content[0].text.includes(request.interventionId)) {
    return { kind: 'conflict' }
  }
  return classifyOpening(events, request)
}

function classifyOpening(
  events: readonly SessionEvent[],
  request: InspectInterventionOpeningRequest,
): InterventionOpeningEvidence {
  const calls: SessionEvent<'tool/call'>[] = []
  const results: SessionEvent<'tool/result'>[] = []
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.callId === request.callId) calls.push(event)
    if (event.type === 'tool/result'
      && (event.data.message.source.callId === request.callId
        || event.data.message.content[0].toolCallId === request.callId)) results.push(event)
  }
  if (calls.length === 0 && results.length === 0) return { kind: 'absent' }
  const call = calls[0]
  if (call === undefined || calls.length !== 1 || results.length > 1) return { kind: 'conflict' }
  if (call.data.name !== 'request_intervention'
    || !matchesQuestionArguments(call.data.arguments, request.expectedQuestion)) return { kind: 'conflict' }
  const turnStarts: SessionEvent<'turn/start'>[] = []
  const stepStarts: SessionEvent<'step/start'>[] = []
  const stepEnds: SessionEvent<'step/end'>[] = []
  const turnEnds: SessionEvent<'turn/end'>[] = []
  for (const event of events) {
    if (event.type === 'turn/start' && event.data.turn === call.data.turn) turnStarts.push(event)
    if (event.type === 'step/start'
      && event.data.turn === call.data.turn
      && event.data.step === call.data.step) stepStarts.push(event)
    if (event.type === 'step/end'
      && event.data.turn === call.data.turn
      && event.data.step === call.data.step) stepEnds.push(event)
    if (event.type === 'turn/end' && event.data.turn === call.data.turn) turnEnds.push(event)
  }
  const turnStart = turnStarts[0]
  const stepStart = stepStarts[0]
  if (turnStart === undefined || stepStart === undefined
    || turnStarts.length !== 1 || stepStarts.length !== 1
    || turnStart.seq >= stepStart.seq || stepStart.seq >= call.seq
    || stepEnds.length > 1 || turnEnds.length > 1) return { kind: 'conflict' }

  const result = results[0]
  if (result === undefined) {
    return stepEnds.length > 0 || turnEnds.length > 0
      ? { kind: 'conflict' }
      : { kind: 'pending' }
  }
  const block = result.data.message.content[0]
  if (result.seq <= call.seq
    || result.data.turn !== call.data.turn
    || result.data.step !== call.data.step
    || result.surfaceOp !== 'append'
    || !isDeepStrictEqual(result.sourceEventSeqs, [call.seq])
    || result.data.error !== undefined
    || result.data.message.source.callId !== request.callId
    || block.toolCallId !== request.callId
    || block.isError
    || !isDeepStrictEqual(block.content, request.expectedToolResult.content)) {
    return { kind: 'conflict' }
  }

  if (events.some(event => event.type === 'step/start'
    && event.data.turn === call.data.turn && event.seq > result.seq)) return { kind: 'conflict' }
  const stepEnd = stepEnds[0]
  const turnEnd = turnEnds[0]
  if (stepEnd !== undefined && stepEnd.seq <= result.seq
    || turnEnd !== undefined && (stepEnd === undefined || turnEnd.seq <= stepEnd.seq)) {
    return { kind: 'conflict' }
  }
  if (stepEnd === undefined || turnEnd === undefined) return { kind: 'pending' }
  if (turnEnd.data.reason.kind !== 'completed') return { kind: 'conflict' }
  return { kind: 'confirmed', turn: call.data.turn, step: call.data.step }
}

function matchesQuestionArguments(argumentsJson: string, expectedQuestion: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return false
  }
  return typeof parsed === 'object'
    && parsed !== null
    && !Array.isArray(parsed)
    && Object.keys(parsed).length === 1
    && Reflect.get(parsed, 'question') === expectedQuestion
}
