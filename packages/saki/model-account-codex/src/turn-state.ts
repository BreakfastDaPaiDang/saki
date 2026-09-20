/** Account-local, turn-scoped Codex HTTP state. @module @breakfastdapaidang/saki-model-account-codex/turn-state */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { FetchFunction, ProviderResponse } from '@earendil-works/pi-ai'

interface TurnState {
  readonly turn: number
  active: boolean
  value: string | undefined
}

/** One account route owns one instance; response state never leaves this process. */
export class CodexTurnState {
  private readonly sessions = new Map<string, TurnState>()
  private closed = false

  /**
   * Capture transport state before credentials or payload preparation can await.
   * @param request - frozen DSH request identity and cancellation.
   * @returns public pi-ai HTTP hooks preserving account and request ownership.
   */
  prepare(request: GenerateOptions): { fetch: FetchFunction; onResponse: (response: ProviderResponse) => void } {
    if (this.closed) throw new LlmError('Model Account route is unavailable', 'ACCOUNT_UNAVAILABLE')
    request.signal?.throwIfAborted()
    const sessionId = request.sessionId
    const turn = request.turn
    let entry: TurnState | undefined
    if (sessionId !== undefined && turn !== undefined) {
      const previous = this.sessions.get(sessionId)
      if (previous !== undefined && (turn < previous.turn || (turn === previous.turn && !previous.active))) {
        throw new LlmError('Model Account request belongs to an ended turn', 'INACTIVE_TURN')
      }
      entry = previous?.turn === turn ? previous : { turn, active: true, value: undefined }
      this.sessions.set(sessionId, entry)
    }
    const captured = entry
    const state = captured?.value
    const current = (): boolean => !this.closed && !request.signal?.aborted
      && (captured === undefined || (captured.active && (sessionId === undefined ? undefined : this.sessions.get(sessionId)) === captured))
    return {
      fetch: async (input, init) => {
        if (!current()) throw new LlmError('Model Account request is no longer active', 'INACTIVE_TURN')
        const headers = new Headers(init?.headers)
        for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
        headers.set('originator', 'saki')
        for (const name of ['session-id', 'thread-id', 'x-client-request-id', 'x-codex-turn-state']) headers.delete(name)
        if (captured !== undefined && sessionId !== undefined) {
          headers.set('session-id', sessionId)
          headers.set('thread-id', sessionId)
          headers.set('x-client-request-id', sessionId)
          if (state !== undefined) headers.set('x-codex-turn-state', state)
        }
        return globalThis.fetch(input, { ...init, headers })
      },
      onResponse: (response: ProviderResponse) => {
        if (captured !== undefined && current() && captured.value === undefined
          && response.status >= 200 && response.status < 300) {
          captured.value = response.headers['x-codex-turn-state']
        }
      },
    }
  }

  /**
   * Clear only the matching turn; a late end event cannot close its successor.
   * @param sessionId - Session whose turn ended.
   * @param turn - durable turn/end number.
   */
  end(sessionId: string, turn: number): void {
    const entry = this.sessions.get(sessionId)
    if (entry?.turn !== turn) return
    entry.active = false
    entry.value = undefined
  }

  /**
   * Discard the disposed Session’s retained turn identity.
   * @param sessionId - disposed Session.
   */
  release(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Invalidate captured callbacks and discard all account-local state. */
  dispose(): void {
    this.closed = true
    this.sessions.clear()
  }
}
