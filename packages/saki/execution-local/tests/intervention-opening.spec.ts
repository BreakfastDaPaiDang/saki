import { CallId, createToolResultMessage, MessageId, type ContentBlock, type ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type SessionPersistence,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  InspectInterventionOpeningRequest,
  SakiHostId,
  SakiInterventionRequestId,
} from '@breakfastdapaidang/saki-execution'
import { describe, expect, it } from 'vitest'
import { inspectLocalInterventionOpening } from '../src/intervention-opening.ts'

const SESSION_ID = SessionId('session-11111111-1111-4111-8111-111111111111')
const HOST_ID = 'host-22222222-2222-4222-8222-222222222222' as SakiHostId
const INTERVENTION_ID =
  'intervention-33333333-3333-4333-8333-333333333333' as SakiInterventionRequestId
const CALL_ID = CallId('request-intervention-1')
const EXPECTED_QUESTION = 'Which exact path should this Agent Run take?'
const EXPECTED_CONTENT = [{ type: 'text', text: `Intervention requested: ${INTERVENTION_ID}` }] as const
const HEADER: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SESSION_ID,
  createdAt: 1,
  cwd: 'C:\\repo',
}

describe('inspectLocalInterventionOpening', () => {
  it('confirms only an exact successful result in the final balanced step of a completed turn', async () => {
    const events = openingEvents()
    const evidence = await inspectLocalInterventionOpening(persistence(events), request(), new AbortController().signal)

    expect(evidence).toEqual({ kind: 'confirmed', turn: 1, step: 1 })
  })

  it('distinguishes absent and incomplete openings without exposing Session events', async () => {
    const signal = new AbortController().signal
    expect(await inspectLocalInterventionOpening(persistence(undefined), request(), signal))
      .toEqual({ kind: 'absent' })
    expect(await inspectLocalInterventionOpening(persistence([]), request(), signal))
      .toEqual({ kind: 'absent' })
    expect(await inspectLocalInterventionOpening(persistence(openingEvents().slice(0, 3)), request(), signal))
      .toEqual({ kind: 'pending' })
    expect(await inspectLocalInterventionOpening(
      persistence(openingEvents().slice(0, 4)),
      request(),
      signal,
    )).toEqual({ kind: 'pending' })
    expect(await inspectLocalInterventionOpening(
      persistence(openingEvents().slice(0, 5)),
      request(),
      signal,
    )).toEqual({ kind: 'pending' })
  })

  it('rejects mismatched results and later model steps as conflicts', async () => {
    const mismatched = structuredClone(openingEvents())
    const result = mismatched.find(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('missing result fixture')
    result.data.message.content[0].content[0] = { type: 'text', text: 'different' }

    const laterStep = openingEvents()
    laterStep.splice(-1, 0,
      { type: 'step/start', seq: 5, time: 6, data: { turn: 1, step: 2 } },
      { type: 'step/end', seq: 6, time: 7, data: { turn: 1, step: 2 } },
    )
    laterStep[7] = { type: 'turn/end', seq: 7, time: 8, data: { turn: 1, reason: { kind: 'completed' } } }

    const signal = new AbortController().signal
    expect(await inspectLocalInterventionOpening(persistence(mismatched), request(), signal))
      .toEqual({ kind: 'conflict' })
    expect(await inspectLocalInterventionOpening(persistence(laterStep), request(), signal))
      .toEqual({ kind: 'conflict' })
  })

  it('fails closed for conflicting call, result, and lifecycle evidence', async () => {
    const otherCallId = CallId('other-call')
    const cases: Array<readonly [string, SessionEvent[]]> = [
      ['orphan result', changed(events => events.splice(2, 1))],
      ['duplicate call', changed(events => events.splice(3, 0, structuredClone(toolCall(events))))],
      ['duplicate result', changed(events => events.splice(4, 0, structuredClone(toolResult(events))))],
      ['wrong tool', changed((events) => { toolCall(events).data.name = 'other' })],
      ['wrong question', changed((events) => {
        toolCall(events).data.arguments = JSON.stringify({ question: 'Use another question.' })
      })],
      ['extra argument', changed((events) => {
        toolCall(events).data.arguments = JSON.stringify({ question: EXPECTED_QUESTION, extra: true })
      })],
      ['malformed arguments', changed((events) => { toolCall(events).data.arguments = '{' })],
      ['missing turn start', changed(events => events.splice(0, 1))],
      ['missing step start', changed(events => events.splice(1, 1))],
      ['duplicate turn start', changed(events => events.splice(1, 0, structuredClone(turnStart(events))))],
      ['duplicate step start', changed(events => events.splice(2, 0, structuredClone(stepStart(events))))],
      ['turn starts after step', changed((events) => { turnStart(events).seq = stepStart(events).seq })],
      ['call precedes step', changed((events) => { stepStart(events).seq = toolCall(events).seq })],
      ['duplicate step end', changed(events => events.splice(5, 0, structuredClone(stepEnd(events))))],
      ['duplicate turn end', changed(events => events.push(structuredClone(turnEnd(events))))],
      ['closed call without result', changed(events => events.splice(3, 1))],
      ['result before call', changed((events) => { toolResult(events).seq = toolCall(events).seq })],
      ['result in another turn', changed((events) => { toolResult(events).data.turn = 2 })],
      ['result in another step', changed((events) => { toolResult(events).data.step = 2 })],
      ['replacement result', changed((events) => { toolResult(events).surfaceOp = { op: 'replace', start: 1, end: 1 } })],
      ['wrong result source seq', changed((events) => { toolResult(events).sourceEventSeqs = [1] })],
      ['result failure identity', changed((events) => { toolResult(events).data.error = { name: 'Error', code: 'FAIL' } })],
      ['message source mismatch', changed((events) => {
        toolResult(events).data.message = resultMessage(otherCallId, CALL_ID, EXPECTED_CONTENT, false)
      })],
      ['result block mismatch', changed((events) => {
        toolResult(events).data.message = resultMessage(CALL_ID, otherCallId, EXPECTED_CONTENT, false)
      })],
      ['error result', changed((events) => {
        toolResult(events).data.message = resultMessage(CALL_ID, CALL_ID, EXPECTED_CONTENT, true)
      })],
      ['step end before result', changed((events) => { stepEnd(events).seq = toolResult(events).seq })],
      ['turn end without step end', changed(events => events.splice(4, 1))],
      ['turn end before step end', changed((events) => { turnEnd(events).seq = stepEnd(events).seq })],
      ['non-completed turn', changed((events) => { turnEnd(events).data.reason = { kind: 'interrupted' } })],
    ]
    const signal = new AbortController().signal
    for (const [name, events] of cases) {
      expect(await inspectLocalInterventionOpening(persistence(events), request(), signal), name)
        .toEqual({ kind: 'conflict' })
    }
    const otherIntervention = 'intervention-44444444-4444-4444-8444-444444444444' as SakiInterventionRequestId
    expect(await inspectLocalInterventionOpening(
      persistence(openingEvents()),
      { ...request(), interventionId: otherIntervention },
      signal,
    )).toEqual({ kind: 'conflict' })
  })
})

function request(): InspectInterventionOpeningRequest {
  return {
    hostId: HOST_ID,
    sessionId: SESSION_ID,
    callId: CALL_ID,
    interventionId: INTERVENTION_ID,
    expectedQuestion: EXPECTED_QUESTION,
    expectedToolResult: { content: EXPECTED_CONTENT },
  }
}

function openingEvents(): SessionEvent[] {
  const result = createToolResultMessage({ callId: CALL_ID, content: [...EXPECTED_CONTENT], isError: false })
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'tool/call',
      seq: 2,
      time: 3,
      data: {
        turn: 1,
        step: 1,
        callId: CALL_ID,
        name: 'request_intervention',
        arguments: JSON.stringify({ question: EXPECTED_QUESTION }),
      },
    },
    {
      type: 'tool/result',
      seq: 3,
      time: 4,
      data: { turn: 1, step: 1, message: result },
      surfaceOp: 'append',
      sourceEventSeqs: [2],
    },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function persistence(events: SessionEvent[] | undefined): Pick<SessionPersistence, 'listSnapshots' | 'readFrom'> {
  return {
    listSnapshots: () => Promise.resolve([{
      header: events === undefined ? { ...HEADER, id: SessionId('session-other') } : HEADER,
      revision: SessionPersistenceRevision('test:1'),
    }]),
    readFrom: () => {
      if (events === undefined) return Promise.reject(new Error('not found'))
      return Promise.resolve({ meta: HEADER, events })
    },
  }
}

function changed(change: (events: SessionEvent[]) => void): SessionEvent[] {
  const events = structuredClone(openingEvents())
  change(events)
  return events
}

function turnStart(events: SessionEvent[]): SessionEvent<'turn/start'> {
  const event = events.find((candidate): candidate is SessionEvent<'turn/start'> => candidate.type === 'turn/start')
  if (event === undefined) throw new Error('missing turn start fixture')
  return event
}

function stepStart(events: SessionEvent[]): SessionEvent<'step/start'> {
  const event = events.find((candidate): candidate is SessionEvent<'step/start'> => candidate.type === 'step/start')
  if (event === undefined) throw new Error('missing step start fixture')
  return event
}

function toolCall(events: SessionEvent[]): SessionEvent<'tool/call'> {
  const event = events.find((candidate): candidate is SessionEvent<'tool/call'> => candidate.type === 'tool/call')
  if (event === undefined) throw new Error('missing tool call fixture')
  return event
}

function toolResult(events: SessionEvent[]): SessionEvent<'tool/result'> {
  const event = events.find((candidate): candidate is SessionEvent<'tool/result'> => candidate.type === 'tool/result')
  if (event === undefined) throw new Error('missing tool result fixture')
  return event
}

function stepEnd(events: SessionEvent[]): SessionEvent<'step/end'> {
  const event = events.find((candidate): candidate is SessionEvent<'step/end'> => candidate.type === 'step/end')
  if (event === undefined) throw new Error('missing step end fixture')
  return event
}

function turnEnd(events: SessionEvent[]): SessionEvent<'turn/end'> {
  const event = events.find((candidate): candidate is SessionEvent<'turn/end'> => candidate.type === 'turn/end')
  if (event === undefined) throw new Error('missing turn end fixture')
  return event
}

function resultMessage(
  sourceCallId: ReturnType<typeof CallId>,
  blockCallId: ReturnType<typeof CallId>,
  content: readonly ContentBlock[],
  isError: boolean,
): ToolResultMessage {
  return {
    id: MessageId('intervention-opening-result'),
    role: 'user',
    source: { kind: 'tool', callId: sourceCallId },
    content: [{ type: 'tool-result', toolCallId: blockCallId, content: [...content], isError }],
  }
}
