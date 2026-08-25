import type { CredentialRef } from './types.ts'

/** POSIX-style identifier grammar shared by credential-reference entry points. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Brand a raw string as a {@link CredentialRef}.
 * @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
 * @returns the branded reference.
 * @throws TypeError when `value` is not a POSIX shell identifier.
 */
export function credentialRef(value: string): CredentialRef {
  if (!isCredentialRefName(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  }
  return value as CredentialRef
}

/**
 * Whether a raw string could name a credential reference.
 * @param value - candidate reference.
 * @returns true when {@link credentialRef} would accept it.
 */
export function isCredentialRefName(value: string): boolean {
  return REF_PATTERN.test(value)
}
