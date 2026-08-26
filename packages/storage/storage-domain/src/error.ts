/**
 * Error vocabulary of the domain data form.
 * @module @deepseek-ai/dsh-storage-domain/src/error
 */

/** Discriminant codes carried by every {@link DomainError}. */
export type DomainErrorCode =
  | 'already-open'
  | 'facet-unsupported'
  | 'invalid-record'
  | 'migration-unsupported'
  | 'migration-source-missing'
  | 'migration-version'
  | 'migration-layout'
  | 'migration-plan'
  | 'migration-step'
  | 'migration-target-invalid'
  | 'migration-target-durability-uncertain'
  | 'migration-target-not-committed'
  | 'migration-target-outcome-unknown'
  | 'write-outcome-uncertain'
  | 'missing-key'
  | 'closed'

/** Location of the record that failed schema validation at the durable boundary. */
export interface InvalidRecordDetail {
  /** Table holding the rejected record; `''` for the global singleton. */
  readonly table: string
  /** Key of the rejected record; `''` for the global singleton. */
  readonly key: string
}

/** Construction options: standard `cause` plus structured durable-state evidence. */
export interface DomainErrorOptions extends ErrorOptions {
  /** Record location for `invalid-record`, including one nested in a committed target failure. */
  readonly detail?: InvalidRecordDetail
  /** True when target publication is known to have occurred before the reported failure. */
  readonly committed?: true
}

/**
 * Error thrown by the domain layer. The `code` is the stable contract
 * consumers may switch on; `message` is diagnostic prose. Backend failures
 * (`backend-not-found`, `version-mismatch`, …) pass through as
 * `StorageError` — the domain layer does not rewrap them.
 */
export class DomainError extends Error {
  override readonly name = 'DomainError'

  /** Record location when schema validation identified one. */
  readonly detail?: InvalidRecordDetail
  /** True when target publication is known to have occurred before this failure. */
  readonly committed?: true

  /**
   * @param code - Stable discriminant for the failure class.
   * @param message - Human-readable diagnostic detail.
   * @param options - Standard error options plus durable-state evidence.
   */
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    options?: DomainErrorOptions,
  ) {
    super(message, options)
    if (options?.detail) this.detail = options.detail
    if (options?.committed) this.committed = true
  }
}

/**
 * Parse one stored domain value and attach its durable location to schema failures.
 * @param domain - Domain containing the value.
 * @param table - Table containing the value, or `''` for the global singleton.
 * @param key - Record key, or `''` for the global singleton.
 * @param parse - Schema parse operation.
 * @returns the parsed value.
 */
export function parseStoredDomainValue<T>(
  domain: string,
  table: string,
  key: string,
  parse: () => T,
): T {
  try {
    return parse()
  } catch (error) {
    const slot = table === '' ? 'global' : `record '${key}' in table '${table}'`
    throw new DomainError(
      'invalid-record',
      `domain '${domain}': stored ${slot} does not match its schema`,
      { detail: { table, key }, cause: error },
    )
  }
}
