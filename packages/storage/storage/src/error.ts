/**
 * Error vocabulary for the storage hub and its backends.
 * @module @deepseek-ai/dsh-storage/src/error
 */

/** Discriminant codes carried by every {@link StorageError}. */
export type StorageErrorCode =
  | 'backend-not-found'
  | 'form-not-mounted'
  | 'duplicate-backend'
  | 'duplicate-mount'
  | 'version-mismatch'
  | 'malformed-medium'
  | 'unit-not-found'
  | 'unit-open'
  | 'target-exists'
  | 'durability-uncertain'
  | 'commit-outcome-unknown'
  | 'closed'

/**
 * Error thrown by the hub and by backend implementations. The `code` is the
 * stable contract consumers may switch on; `message` is diagnostic prose.
 */
export class StorageError extends Error {
  override readonly name = 'StorageError'
  /** True when the requested value is already visible at its final path. */
  declare readonly published?: true
  /** True when a failed commit may nevertheless have published the requested value. */
  declare readonly publicationPossible?: true

  /**
   * @param code - Stable discriminant for the failure class.
   * @param message - Human-readable diagnostic detail.
   * @param options - Standard error options (`cause`).
   */
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    if (code === 'durability-uncertain') this.published = true
    if (code === 'commit-outcome-unknown') this.publicationPossible = true
  }
}

/**
 * Identify a storage failure whose commit may have published the requested
 * value but did not produce enough evidence to decide either way.
 * @param error - Candidate failure from a backend write.
 * @returns whether publication remains possible but unconfirmed.
 */
export function isCommitOutcomeUnknownStorageError(
  error: unknown,
): error is StorageError & {
  readonly code: 'commit-outcome-unknown'
  readonly publicationPossible: true
} {
  return error instanceof StorageError
    && error.code === 'commit-outcome-unknown'
    && error.publicationPossible === true
}

/**
 * Identify a storage failure that happened after namespace publication.
 * @param error - Candidate failure from a backend write.
 * @returns whether the requested value is already visible at its final path.
 */
export function isPublishedStorageError(
  error: unknown,
): error is StorageError & { readonly code: 'durability-uncertain'; readonly published: true } {
  return error instanceof StorageError
    && error.code === 'durability-uncertain'
    && error.published === true
}
