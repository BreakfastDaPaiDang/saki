/** Event ordering and cancellation for the inheritance snapshot's child barrier. */

import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as fixture from './fixtures/parent-sandbox-override.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function agent(id: string, parentSession?: SessionId): Agent {
  const empty = Session.create(SessionId(id))
  const session = Session.create(empty.id, [], {
    ...empty.header,
    ...parentSession === undefined ? {} : { parentSession },
  })
  // These fixture events read Session metadata and never call Agent operations.
  return { session } as Agent
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = await ctx.plugin(fixture)
  const parent = agent('parent')
  const child = agent('child', parent.session.id)
  ctx.emit('agent/created', { agent: parent })
  ctx.emit('agent/created', { agent: child })
  const next = vi.fn(() => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }))
  const start = (signal = new AbortController().signal) => ctx.waterfall('agent/pre-step', {
    agent: child, messages: [], turn: 1, step: 1, signal,
  }, next)
  return { ctx, fiber, parent, child, next, start }
}

it('holds child replay until the parent finishes its first turn and becomes idle', async () => {
  const { ctx, parent, next, start } = await setup()
  const abort = new AbortController()
  const pending = start(abort.signal)
  try {
    expect(next).not.toHaveBeenCalled()
    ctx.emit('agent/status', { agent: parent, status: 'idle' })
    const other = agent('other')
    ctx.emit('agent/created', { agent: other })
    other.session.append('turn/start', { turn: 1 })
    ctx.emit('session/event', other.session, other.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    ctx.emit('agent/status', { agent: other, status: 'idle' })
    await Promise.resolve()
    expect(next).not.toHaveBeenCalled()
    parent.session.append('turn/start', { turn: 1 })
    const ended = parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ctx.emit('session/event', parent.session, ended)
    await Promise.resolve()
    expect(next).not.toHaveBeenCalled()
    ctx.emit('agent/status', { agent: parent, status: 'idle' })
    await pending
    expect(next).toHaveBeenCalledOnce()
    await start()
    expect(next).toHaveBeenCalledTimes(2)
  } finally {
    abort.abort()
    await Promise.allSettled([pending])
  }
})

it('cancels a child waiting for its parent without continuing the replay', async () => {
  const { next, start } = await setup()
  const abort = new AbortController()
  const pending = start(abort.signal)
  const rejected = expect(pending).rejects.toThrow('child cancelled')
  abort.abort(new Error('child cancelled'))
  await rejected
  expect(next).not.toHaveBeenCalled()
})

it('releases child waits and removes the barrier when the fixture is disposed', async () => {
  const { fiber, next, start } = await setup()
  const pending = start()
  const rejected = expect(pending).rejects.toThrow('inheritance snapshot disposed')
  await fiber.dispose()
  await rejected
  expect(next).not.toHaveBeenCalled()
  await start()
  expect(next).toHaveBeenCalledOnce()
})
