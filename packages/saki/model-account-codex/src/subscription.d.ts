/** Public helper declarations for the pinned JavaScript-only subscription release. */
declare module 'dsh-codex-subscription' {
  import type { AuthResult, OAuthCredential } from '@earendil-works/pi-ai'

  /**
   * Create the maintained account-bound usage reader.
   * @param options - immutable account callbacks and request timeout.
   * @returns a reader whose external payload is validated by the Saki consumer.
   */
  export function createCodexUsageReader(options: {
    getAuth: (options: { signal?: AbortSignal }) => Promise<AuthResult | undefined>
    readCredential: (options: { signal?: AbortSignal }) => Promise<OAuthCredential | undefined>
    fetch: typeof globalThis.fetch
    timeoutMs: number
  }): { read(options: { signal: AbortSignal }): Promise<unknown> }
}
