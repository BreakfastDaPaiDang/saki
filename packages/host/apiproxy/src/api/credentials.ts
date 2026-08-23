/**
 * credentials domain contract: the web face of the credential-reference seam
 * (`ctx.credentials`). Reads are structurally value-free — a credential view
 * carries safe identity, protection, availability, and writability metadata
 * with no slot for the value — and the value crosses the wire in exactly one
 * direction, inside `credentials.set`.
 * There is no enumeration method by design: clients learn which references
 * exist from settings schemas and values (`apiKeyEnv` fields).
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { CredentialHealth, CredentialProtectionLevel, CredentialRef } from '@deepseek-ai/dsh-credentials/types'

/** Wire view of one credential reference's state. */
export interface CredentialView {
  /** Reference this observation describes. */
  ref: CredentialRef
  /** Whether the provider has a record or effective source assigned to this reference. */
  configured: boolean
  /** Winning layer when configured (`env`, `file`, …); provider vocabulary. */
  source?: string
  /** Provider-defined recovery trust model of the effective or writable source. */
  protectionLevel: CredentialProtectionLevel
  /** Whether `credentials.set`/`credentials.unset` can affect this reference. */
  writable: boolean
  /** Whether the value is available, absent, or present but unusable. */
  health: CredentialHealth
  /** Unix epoch milliseconds at which the provider made this observation. */
  observedAt: number
}

/** Credentials-domain unary methods (the map keys credentials.* of RpcMethodMap). */
export interface CredentialsApi {
  /**
   * Describe the named references (batch): identity, configured state,
   * winning source, protection, health, observation time, and writability —
   * never values. An invalid reference name is a `bad-request`; an
   * unknown-but-valid one describes as unconfigured.
   */
  describe(request: RpcRequest<{ refs: string[] }>): Promise<RpcResponse<{ credentials: Record<string, CredentialView> }>>

  /**
   * Store one credential value in the writable layer. Rejected with
   * `credential-rejected` while a read-only layer (the live environment)
   * shadows the reference — the write would otherwise appear to succeed while
   * resolution keeps returning the shadowing value.
   */
  set(request: RpcRequest<{ ref: string; value: string }>): Promise<RpcResponse<{}>>

  /**
   * Remove one credential from the writable layer; same shadowing rejection
   * as `set`. Unsetting an absent reference succeeds (idempotent).
   */
  unset(request: RpcRequest<{ ref: string }>): Promise<RpcResponse<{}>>
}
