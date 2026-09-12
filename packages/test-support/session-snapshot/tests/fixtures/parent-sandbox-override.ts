/** Policy inheritance and parent-before-child completion for the SDK snapshot. */

import type { Context } from '@deepseek-ai/cordis'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'parent-sandbox-override'

/**
 * Set root policy before delegation and hold the child until its parent's
 * first idle. Earlier settlement steers the parent's current turn; this
 * recorded scenario requires the settlement notice to start a second turn.
 * @param ctx - the inheritance scenario's profile context.
 */
export function apply(ctx: Context): void {
  const parents = new Map<SessionId, { ended: boolean; idle: PromiseWithResolvers<undefined> }>()
  const disposed = new AbortController()
  ctx.effect(() => () => {
    disposed.abort(new Error('inheritance snapshot disposed'))
    for (const parent of parents.values()) parent.idle.resolve(undefined)
    parents.clear()
  })
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    setSandboxMode(agent.session, 'read-only')
    parents.set(agent.session.id, { ended: false, idle: Promise.withResolvers<undefined>() })
  })
  ctx.on('session/event', (session, event) => {
    const parent = parents.get(session.id)
    if (parent !== undefined && event.type === 'turn/end' && event.data.turn === 1) parent.ended = true
  })
  ctx.on('agent/status', ({ agent, status }) => {
    const parent = parents.get(agent.session.id)
    if (status === 'idle' && parent?.ended === true) parent.idle.resolve(undefined)
  })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const parentId = agent.session.header.parentSession
    if (parentId === undefined) return next()
    const parent = parents.get(parentId)
    if (parent === undefined) throw new Error(`inheritance snapshot has no root parent ${parentId}`)
    const cancellation = AbortSignal.any([signal, disposed.signal])
    cancellation.throwIfAborted()
    const aborted = Promise.withResolvers<never>()
    const onAbort = (): void => { aborted.reject(cancellation.reason) }
    cancellation.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.race([parent.idle.promise, aborted.promise])
    } finally {
      cancellation.removeEventListener('abort', onAbort)
    }
    cancellation.throwIfAborted()
    return next()
  })
}
