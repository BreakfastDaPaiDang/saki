import { describe, expect, it } from 'vitest'
import { SAKI_AGENT_RUN_VIEW_PROJECTION_FIXTURE as run, SAKI_PROJECT_SESSIONS_PROJECTION_FIXTURE as sessions } from '@breakfastdapaidang/saki-control-plane/fixtures'
import { sakiAgentRunViewResultSchema, sakiProjectSessionsResultSchema, sakiQueryRequestSchema } from '../src/wire.ts'

const result = { ok: true, projection: run }
const sessionQuery = { type: 'project-sessions', projectId: run.projectId, workItemId: null, after: null }
const runQuery = { type: 'agent-run-view', projectId: run.projectId, agentRunId: run.run.id, afterDispatch: null, terminal: null }
const terminalId = 'terminal-11111111-1111-4111-8111-111111111111:pty-1'
const terminal = { id: terminalId, name: 'Build output', type: 'bash', process: { state: 'exited', exitCode: 1, signal: null } }
const page = { state: 'confirmed', id: terminalId, text: 'build failed\n', totalLines: 3, lineBegin: 0, lineEnd: 3, truncated: false }
const terminals = { state: 'confirmed', items: [terminal], more: false, selected: page }
const terminalResult = { ...result, projection: { ...run, observation: { ...run.observation, terminals } } }

describe('Session and Run query wire', () => {
  it('accepts bounded cursor addresses and rejects client-supplied authority or commands', () => {
    for (const query of [sessionQuery, runQuery, { ...sessionQuery, workItemId: run.workSession.workItem.id, after: run.workSession.id },
      { ...runQuery, afterDispatch: run.dispatches[0]!.id, terminal: { id: terminalId, offset: 80 } }]) {
      expect(sakiQueryRequestSchema.parse(query)).toEqual(query)
      for (const extra of [{ command: 'cat private' }, { cwd: '/private' }, { principalId: 'private' }, { sessionId: run.run.sessionId }]) {
        expect(sakiQueryRequestSchema.safeParse({ ...query, ...extra }).success).toBe(false)
      }
    }
    for (const bad of [{ id: terminalId, offset: -1 }, { id: terminalId, offset: 0.5 },
      { id: terminalId, offset: Number.MAX_SAFE_INTEGER + 1 },
      { id: '', offset: 0 }, { id: 'a b', offset: 0 }, { id: 'a\u0000b', offset: 0 }, { id: 'a'.repeat(513), offset: 0 }, { id: terminalId, offset: 0, command: 'echo' }]) {
      expect(sakiQueryRequestSchema.safeParse({ ...runQuery, terminal: bad }).success).toBe(false)
    }
    for (const bad of [{ ...sessionQuery, after: 'bad' }, { ...sessionQuery, workItemId: 'bad' }, { ...runQuery, agentRunId: 'bad' }, { ...runQuery, afterDispatch: 'bad' }]) {
      expect(sakiQueryRequestSchema.safeParse(bad).success).toBe(false)
    }
  })
  it('round-trips independent failed execution, readable history and unavailable Terminal facts', () => {
    expect(sakiProjectSessionsResultSchema.parse({ ok: true, projection: sessions })).toEqual({ ok: true, projection: sessions })
    expect(sakiAgentRunViewResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result)
    expect(sakiAgentRunViewResultSchema.parse(terminalResult)).toEqual(terminalResult)
    for (const reason of ['denied', 'unavailable', 'not-found']) {
      for (const schema of [sakiAgentRunViewResultSchema, sakiProjectSessionsResultSchema]) {
        expect(schema.parse({ ok: false, reason })).toEqual({ ok: false, reason })
      }
    }
  })
  it('rejects foreign, repeated and oversized Session destinations', () => {
    for (const projection of [
      { ...sessions, items: Array.from({ length: 33 }, () => sessions.items[0]) },
      { ...sessions, items: [sessions.items[0], sessions.items[0]] },
      { ...sessions, workItemId: `work-item-${'9'.repeat(64)}` },
      { ...sessions, next: 'work-session-11111111-1111-4111-8111-111111111111' },
      { ...sessions, items: [{ ...run.workSession, runs: [] }] },
      { ...sessions, items: [{ ...run.workSession, runs: [run.workSession.runs[0], run.workSession.runs[0]] }] },
      { ...sessions, items: [{ ...run.workSession, assignment: { ...run.workSession.assignment, currentAgentRunId: 'agent-run-11111111-1111-4111-8111-111111111111' } }] },
      { ...sessions, items: [{ ...run.workSession, updatedAt: 0 }] },
      { ...sessions, items: [{ ...run.workSession, runs: [{ ...run.workSession.runs[0], updatedAt: 0 }] }] },
      { ...sessions, items: [{ ...run.workSession, canonicalWorktreePath: '/private' }] },
    ]) expect(sakiProjectSessionsResultSchema.safeParse({ ok: true, projection }).success).toBe(false)
  })
  it('rejects unsupported success, mismatched Run identities and private Dispatch authority', () => {
    for (const projection of [
      { ...run, status: 'succeeded' }, { ...run, run: { ...run.run, sessionId: 'session-11111111-1111-4111-8111-111111111111' } },
      { ...run, run: { ...run.run, state: 'canceled' } }, { ...run, run: { ...run.run, updatedAt: 0 } },
      { ...run, run: { ...run.run, profile: { ...run.run.profile, credentialRef: 'secret' } } },
      { ...run, dispatches: [run.dispatches[0], run.dispatches[0]] },
      { ...run, dispatches: Array.from({ length: 33 }, () => run.dispatches[0]) },
      { ...run, dispatches: [{ ...run.dispatches[0], updatedAt: 0 }] },
      { ...run, dispatches: [{ ...run.dispatches[0], acceptance: 'private' }] },
      { ...run, dispatches: [{ ...run.dispatches[0], operation: { ...run.dispatches[0]!.operation, requestFingerprint: 'private' } }] },
      { ...run, nextDispatch: 'dispatch-11111111-1111-4111-8111-111111111111' },
      { ...run, observation: { ...run.observation, canonicalWorktreePath: '/private' } },
    ]) expect(sakiAgentRunViewResultSchema.safeParse({ ok: true, projection }).success).toBe(false)
  })
  it('enforces complete Terminal response limits and selected owner membership', () => {
    const invalid = [
      { ...terminals, items: [terminal, terminal] }, { ...terminals, items: Array.from({ length: 33 }, () => terminal) },
      { ...terminals, items: [] }, { ...terminals, selected: { ...page, id: 'terminal-other:pty-1' } },
      { ...terminals, selected: { ...page, text: 'a'.repeat(65_537) } },
      { ...terminals, selected: { ...page, lineBegin: 4 } }, { ...terminals, selected: { ...page, lineEnd: 4 } },
      { ...terminals, selected: { ...page, totalLines: -1 } },
      { ...terminals, items: [{ ...terminal, name: 'a'.repeat(257) }] },
      { ...terminals, items: [{ ...terminal, process: { state: 'exited', exitCode: 4_294_967_296, signal: null } }] },
      { ...terminals, items: [{ ...terminal, pid: 1234 }] },
    ]
    for (const candidate of invalid) expect(sakiAgentRunViewResultSchema.safeParse({ ...result,
      projection: { ...run, observation: { ...run.observation, terminals: candidate } },
    }).success).toBe(false)
    for (const candidate of [{ ...terminals, selected: null }, { ...terminals, items: [], selected: { state: 'missing', id: terminalId } },
      { ...terminals, selected: { ...page, text: '界'.repeat(65_536) } }]) {
      expect(sakiAgentRunViewResultSchema.safeParse({
        ...result, projection: { ...run, observation: { ...run.observation, terminals: candidate } },
      }).success).toBe(true)
    }
  })
  it('correlates Intervention return destinations and keeps absent Session evidence unavailable', () => {
    const returnAddress = { kind: 'agent-run', projectId: run.projectId, workItemId: run.workSession.workItem.id,
      workSessionId: run.workSession.id, agentRunId: run.run.id }
    const intervention = { id: 'intervention-77777777-7777-4777-8777-777777777777', revision: 3,
      kind: 'text-input', state: 'open', targetPrincipalId: run.run.source.principalId,
      requiredAnswer: { kind: 'text', prompt: 'Keep the current files?', maxLength: 16_384 },
      createdAt: 100, updatedAt: 120, returnAddress }
    expect(sakiAgentRunViewResultSchema.safeParse({ ...result, projection: { ...run, interventions: [intervention] } }).success)
      .toBe(true)
    for (const replacement of [
      { projectId: 'project-11111111-1111-4111-8111-111111111111' }, { workItemId: `work-item-${'9'.repeat(64)}` },
      { workSessionId: 'work-session-11111111-1111-4111-8111-111111111111' },
      { agentRunId: 'agent-run-11111111-1111-4111-8111-111111111111' },
    ]) {
      expect(sakiAgentRunViewResultSchema.safeParse({ ...result, projection: { ...run,
        interventions: [{ ...intervention, returnAddress: { ...returnAddress, ...replacement } }],
      } }).success).toBe(false)
    }
    const unavailable = { ...run, status: 'unavailable', observation: { ...run.observation,
      session: { state: 'unavailable', reason: 'missing' } } }
    expect(sakiAgentRunViewResultSchema.safeParse({ ...result, projection: unavailable }).success).toBe(true)
    expect(sakiAgentRunViewResultSchema.safeParse({ ...result, projection: { ...unavailable, status: 'succeeded' } }).success).toBe(false)
  })
})
