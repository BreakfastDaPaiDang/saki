/** Synchronous owner policy at Session command commit points. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** One operation that can activate or change a Session's execution. */
export interface SessionControlRequest {
  readonly sessionId: SessionId
  readonly action: 'resume' | 'model-selection' | 'prompt' | 'queue' | 'cancel'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Let a Session owner reject generic execution control synchronously.
     * @mode bail
     * @param request - exact Session and operation about to commit.
     * @returns 'denied' to reject, or undefined to delegate to other owners.
     */
    'api-session/authorize-control'(request: SessionControlRequest): 'denied' | undefined
  }
}

/**
 * Check ownership immediately before a command's synchronous execution effect.
 * @param ctx - Host context carrying owner policy listeners.
 * @param sessionId - exact Session affected by the command.
 * @param action - control operation at its commit point.
 */
export function assertSessionControl(ctx: Context, sessionId: SessionId, action: SessionControlRequest['action']): void {
  if (ctx.bail('api-session/authorize-control', { sessionId, action }) === 'denied') {
    throw new RemoteError('session/agent-busy', 'Session execution is controlled by its owner', { reason: 'owner-controlled' })
  }
}
