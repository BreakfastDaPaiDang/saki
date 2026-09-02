import { Context, Service } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type {
  SakiAgentInterventionRequest,
  SakiAgentInterventionRequestResult,
  SakiInterventionRequestId,
} from '@breakfastdapaidang/saki-control-plane'
import * as toolIntervention from '../src/index.ts'

const INTERVENTION_ID = 'intervention-11111111-1111-4111-8111-111111111111' as SakiInterventionRequestId
const SECOND_INTERVENTION_ID = 'intervention-22222222-2222-4222-8222-222222222222' as SakiInterventionRequestId

class ControlPlaneProbe extends Service {
  readonly requests: SakiAgentInterventionRequest[] = []
  readonly finalized: SakiInterventionRequestId[] = []
  requestResult: SakiAgentInterventionRequestResult = { ok: true, interventionId: INTERVENTION_ID }
  finalizeOutcomes: Array<'open' | 'pending' | Error> = []
  onFinalize: (() => void) | undefined

  readonly agentInterventions = {
    request: (request: SakiAgentInterventionRequest): Promise<SakiAgentInterventionRequestResult> => {
      this.requests.push(request)
      return Promise.resolve(this.requestResult)
    },
    finalizeOpening: (interventionId: SakiInterventionRequestId): Promise<'open' | 'pending'> => {
      this.finalized.push(interventionId)
      this.onFinalize?.()
      const outcome = this.finalizeOutcomes.shift() ?? 'open'
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'sakiControlPlane')
  }
}

async function setup(
  config: { readonly openingRecoveryRetryDelayMs?: number } = { openingRecoveryRetryDelayMs: 1_000 },
): Promise<{ ctx: Context; controlPlane: ControlPlaneProbe }> {
  const ctx = await setupServices()
  await ctx.plugin(toolIntervention, config)
  const controlPlane = ctx.get('sakiControlPlane')
  if (!(controlPlane instanceof ControlPlaneProbe)) throw new Error('Saki Control Plane probe is absent')
  return { ctx, controlPlane }
}

async function setupServices(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ControlPlaneProbe)
  return ctx
}

function caller(session: Session): never {
  return { session } as never
}

describe('request_intervention tool', () => {
  it('supports direct plugin application with its documented default retry delay', async () => {
    const ctx = await setupServices()
    toolIntervention.apply(ctx)

    expect(ctx.tools.schemas().some(tool => tool.name === 'request_intervention')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('registers one narrow model-facing question schema', async () => {
    const { ctx } = await setup()

    expect(ctx.tools.schemas().find(tool => tool.name === 'request_intervention')).toMatchObject({
      name: 'request_intervention',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    })
  })

  it('persists the opening before returning its stable reference and concluding the turn', async () => {
    const { ctx, controlPlane } = await setup()
    const session = ctx.sessions.create(SessionId('session-agent-intervention'))

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-request-intervention'),
      name: 'request_intervention',
      arguments: { question: 'Which migration should I use?' },
      agent: caller(session),
    })

    expect(controlPlane.requests).toEqual([{
      sessionId: session.id,
      toolCallId: 'call-request-intervention',
      prompt: 'Which migration should I use?',
    }])
    expect(result).toMatchObject({
      isError: false,
      concludesTurn: true,
      value: { interventionId: INTERVENTION_ID },
      content: [{ type: 'text', text: JSON.stringify({ interventionId: INTERVENTION_ID }) }],
    })
  })

  it('does not conclude the turn when durable opening admission fails', async () => {
    const { ctx, controlPlane } = await setup()
    controlPlane.requestResult = { ok: false, reason: 'conflict' }
    const session = ctx.sessions.create(SessionId('session-rejected-intervention'))

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-rejected-intervention'),
      name: 'request_intervention',
      arguments: { question: 'Should I continue?' },
      agent: caller(session),
    })

    expect(result).toMatchObject({ isError: true })
    expect(result).not.toHaveProperty('concludesTurn')
  })

  it('requires an active Development Agent caller', async () => {
    const { ctx, controlPlane } = await setup()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-without-agent'),
      name: 'request_intervention',
      arguments: { question: 'Can a non-Agent caller open this?' },
    })

    expect(result).toMatchObject({ isError: true })
    expect(controlPlane.requests).toEqual([])
  })

  it('ignores Session events unrelated to completed turns and sessions without pending openings', async () => {
    const { ctx, controlPlane } = await setup()
    const session = ctx.sessions.create(SessionId('session-without-intervention'))

    ctx.emit('session/event', session, {
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
    })
    ctx.emit('session/event', session, turnEndEvent())

    expect(controlPlane.finalized).toEqual([])
  })

  it('flushes the balanced turn before finalizing its opening request', async () => {
    const { ctx, controlPlane } = await setup()
    const order: string[] = []
    ctx.on('session/flush', () => { order.push('flush') })
    const finalized = Promise.withResolvers<undefined>()
    controlPlane.onFinalize = () => {
      order.push('finalize')
      finalized.resolve(undefined)
    }
    const session = ctx.sessions.create(SessionId('session-finalize-intervention'))
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-finalize-intervention'),
      name: 'request_intervention',
      arguments: { question: 'Which route should I take?' },
      agent: caller(session),
    })

    ctx.emit('session/event', session, {
      type: 'turn/end',
      seq: 0,
      time: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    await finalized.promise

    expect(controlPlane.finalized).toEqual([INTERVENTION_ID])
    expect(order).toEqual(['flush', 'finalize'])
  })

  it('releases local recovery ownership when the durable phase owner reports pending', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, controlPlane } = await setup()
      controlPlane.finalizeOutcomes = ['pending']
      const finalized = Promise.withResolvers<undefined>()
      controlPlane.onFinalize = () => { finalized.resolve(undefined) }
      const session = ctx.sessions.create(SessionId('session-pending-intervention'))
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('call-pending-intervention'),
        name: 'request_intervention',
        arguments: { question: 'Should the durable owner finish this opening?' },
        agent: caller(session),
      })

      ctx.emit('session/event', session, turnEndEvent())
      ctx.emit('session/event', session, turnEndEvent())
      await finalized.promise
      await vi.advanceTimersByTimeAsync(5_000)

      expect(controlPlane.finalized).toEqual([INTERVENTION_ID])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a transient finalization failure without another Session event', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, controlPlane } = await setup()
      controlPlane.finalizeOutcomes = [new Error('temporary failure'), 'open']
      const first = Promise.withResolvers<undefined>()
      const second = Promise.withResolvers<undefined>()
      controlPlane.onFinalize = () => {
        if (controlPlane.finalized.length === 1) first.resolve(undefined)
        if (controlPlane.finalized.length === 2) second.resolve(undefined)
      }
      const session = ctx.sessions.create(SessionId('session-retry-intervention'))
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('call-retry-intervention'),
        name: 'request_intervention',
        arguments: { question: 'Can local recovery retry this opening?' },
        agent: caller(session),
      })

      ctx.emit('session/event', session, turnEndEvent())
      await first.promise
      await vi.advanceTimersByTimeAsync(999)
      expect(controlPlane.finalized).toEqual([INTERVENTION_ID])
      await vi.advanceTimersByTimeAsync(1)
      await second.promise
      await vi.advanceTimersByTimeAsync(2_000)

      expect(controlPlane.finalized).toEqual([INTERVENTION_ID, INTERVENTION_ID])
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one retry timer across failed openings in the same Session and cancels it on disposal', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, controlPlane } = await setup()
      const session = ctx.sessions.create(SessionId('session-shared-intervention-retry'))
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('call-shared-retry-first'),
        name: 'request_intervention',
        arguments: { question: 'Should the first opening retry?' },
        agent: caller(session),
      })
      controlPlane.requestResult = { ok: true, interventionId: SECOND_INTERVENTION_ID }
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('call-shared-retry-second'),
        name: 'request_intervention',
        arguments: { question: 'Should the second opening share that retry?' },
        agent: caller(session),
      })
      const unnamedFailure = new Error('first failure')
      unnamedFailure.name = ''
      controlPlane.finalizeOutcomes = [unnamedFailure, new Error('second failure')]
      const bothFailed = Promise.withResolvers<undefined>()
      controlPlane.onFinalize = () => {
        if (controlPlane.finalized.length === 2) bothFailed.resolve(undefined)
      }

      ctx.emit('session/event', session, turnEndEvent())
      await bothFailed.promise
      await vi.advanceTimersByTimeAsync(0)

      expect(controlPlane.finalized).toEqual([INTERVENTION_ID, SECOND_INTERVENTION_ID])
      expect(vi.getTimerCount()).toBe(1)
      await ctx.fiber.dispose()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles an in-flight non-Error recovery failure during disposal without retrying', async () => {
    const { ctx, controlPlane } = await setup()
    const session = ctx.sessions.create(SessionId('session-disposed-intervention'))
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-disposed-intervention'),
      name: 'request_intervention',
      arguments: { question: 'Can disposal settle this recovery?' },
      agent: caller(session),
    })
    const started = Promise.withResolvers<undefined>()
    const blocked = Promise.withResolvers<'open' | 'pending'>()
    controlPlane.agentInterventions.finalizeOpening = (interventionId) => {
      controlPlane.finalized.push(interventionId)
      started.resolve(undefined)
      return blocked.promise
    }
    ctx.emit('session/event', session, turnEndEvent())
    await started.promise

    const disposing = ctx.fiber.dispose()
    await Promise.resolve()
    blocked.reject('disposed')
    await disposing

    expect(controlPlane.finalized).toEqual([INTERVENTION_ID])
  })
})

function turnEndEvent() {
  return {
    type: 'turn/end' as const,
    seq: 0,
    time: 1,
    data: { turn: 1, reason: { kind: 'completed' as const } },
  }
}
