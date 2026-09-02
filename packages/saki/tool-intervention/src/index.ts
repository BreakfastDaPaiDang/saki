/** Saki Development Agent tool for durable operator Intervention requests. @module @breakfastdapaidang/saki-tool-intervention */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import '@deepseek-ai/cordis-plugin-timer'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  MAX_INTERVENTION_PROMPT_CHARS,
  type SakiInterventionRequestId,
} from '@breakfastdapaidang/saki-control-plane'
import '@breakfastdapaidang/saki-control-plane'
import '@deepseek-ai/dsh-session'

/** Cordis plugin name. */
export const name = 'saki-tool-intervention'
/** Host and Agent-scoped services required by the tool and its durability handoff. */
export const inject = ['tools', 'sessions', 'sakiControlPlane', 'timer']

/** Local recovery scheduling for an Intervention opening. */
export interface Config {
  /** Milliseconds before retrying a transient opening-finalization failure. */
  openingRecoveryRetryDelayMs?: number
}

/** Validated Intervention tool configuration. */
export const Config: z<Config> = z.object({
  openingRecoveryRetryDelayMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(1_000),
})

const description = 'Request durable input from the Saki operator when work cannot continue without a decision or missing information. '
  + 'A successful request ends the current turn; the answer arrives later in the same Agent Run.'

/**
 * Register the Development Agent's durable Intervention request tool.
 * @param ctx - Agent Context carrying Tools, Sessions, and the Saki control plane.
 * @param config - local retry timing for opening finalization.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const openingRecoveryRetryDelayMs = config.openingRecoveryRetryDelayMs ?? 1_000
  const pending = new Map<SessionId, Set<SakiInterventionRequestId>>()
  const recovering = new Set<SakiInterventionRequestId>()
  const active = new Set<Promise<void>>()
  const retryTimers = new Map<SessionId, () => void>()
  const lifetime = new AbortController()

  const clearRetry = (sessionId: SessionId): void => {
    retryTimers.get(sessionId)?.()
    retryTimers.delete(sessionId)
  }

  const wakeSession = (session: Session): void => {
    clearRetry(session.id)
    for (const interventionId of pending.get(session.id) ?? []) recover(session, interventionId)
  }

  const scheduleRetry = (session: Session): void => {
    if (retryTimers.has(session.id)) return
    const dispose = ctx.timeout(() => {
      retryTimers.delete(session.id)
      wakeSession(session)
    }, openingRecoveryRetryDelayMs)
    retryTimers.set(session.id, dispose)
  }

  const recover = (session: Session, interventionId: SakiInterventionRequestId): void => {
    if (recovering.has(interventionId)) return
    recovering.add(interventionId)
    let retry = false
    const operation = (async () => {
      await ctx.sessions.flush(session)
      await ctx.sakiControlPlane.agentInterventions.finalizeOpening(
        interventionId,
        lifetime.signal,
      )
      const requests = pending.get(session.id)
      requests?.delete(interventionId)
      if (requests?.size === 0) {
        pending.delete(session.id)
        clearRetry(session.id)
      }
    })().catch((error: unknown) => {
      if (!lifetime.signal.aborted) {
        retry = true
        ctx.logger.warn(`[saki-tool-intervention] opening recovery failed: ${safeErrorName(error)}`)
      }
    }).finally(() => {
      recovering.delete(interventionId)
      active.delete(operation)
      if (retry) scheduleRetry(session)
    })
    active.add(operation)
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/end') return
    wakeSession(session)
  })

  ctx.effect(() => async () => {
    lifetime.abort(new Error('Saki Intervention tool is disposing'))
    for (const dispose of retryTimers.values()) dispose()
    retryTimers.clear()
    await Promise.all(active)
    pending.clear()
  }, 'saki-tool-intervention.recovery')

  ctx.tools.register(defineTool({
    name: 'request_intervention',
    description,
    parameters: {
      question: {
        type: 'string',
        required: true,
        description: `One concise question the operator must answer before this Agent Run can continue (1-${MAX_INTERVENTION_PROMPT_CHARS} characters).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          interventionId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error('request_intervention requires an active Saki Development Agent')
      }
      const result = await ctx.sakiControlPlane.agentInterventions.request({
        sessionId: exec.agent.session.id,
        toolCallId: exec.callId,
        prompt: args.question,
      }, exec.signal)
      if (!result.ok) {
        throw new Error(`Saki Intervention request is ${result.reason}`)
      }
      let requests = pending.get(exec.agent.session.id)
      if (requests === undefined) {
        requests = new Set()
        pending.set(exec.agent.session.id, requests)
      }
      requests.add(result.interventionId)
      exec.concludeTurn()
      return { interventionId: result.interventionId }
    },
  }))
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name !== '' ? error.name : 'unknown error'
}
