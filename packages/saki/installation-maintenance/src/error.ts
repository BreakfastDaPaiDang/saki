/** Structured Saki Installation-maintenance failures. @module @breakfastdapaidang/saki-installation-maintenance/error */

/** Stable failure classes emitted by cold Installation operations. */
export type SakiMaintenanceErrorCode =
  | 'lease-busy'
  | 'manifest-invalid'
  | 'operation-active'
  | 'recovery-required'
  | 'source-changed'
  | 'state-unsupported'
  | 'target-exists'
  | 'upgrade-required'

/** Error with a machine-readable maintenance failure code. */
export class SakiMaintenanceError extends Error {
  /** Stable machine-readable failure class. */
  readonly code: SakiMaintenanceErrorCode

  /**
   * @param code - stable failure class.
   * @param message - operator-facing diagnostic without secrets.
   * @param options - optional causal failure.
   */
  constructor(code: SakiMaintenanceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SakiMaintenanceError'
    this.code = code
  }
}

/**
 * Preserve Error instances and give non-Error failures a stable diagnostic.
 * @param value - caught failure value.
 * @param message - diagnostic used when the value is not an Error.
 * @returns the original Error or a wrapping Error with the value as its cause.
 */
export function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

/**
 * Test whether a caught Host filesystem failure reports a missing path.
 * @param error - caught failure value.
 * @returns whether Node reported `ENOENT`.
 */
export function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Test whether a caught Host filesystem failure reports an existing target.
 * @param error - caught failure value.
 * @returns whether Node reported `EEXIST`.
 */
export function isExistingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}
