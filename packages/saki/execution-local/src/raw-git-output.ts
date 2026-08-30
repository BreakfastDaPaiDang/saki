/** Shared raw-byte Git output helpers. @module @breakfastdapaidang/saki-execution-local/raw-git-output */

/**
 * Iterate every field from complete NUL-terminated Git output.
 * @param bytes - complete raw Git stdout.
 * @param subject - output name used when the final terminator is absent.
 * @returns borrowed field views into `bytes`.
 */
export function* iterateNulFields(bytes: Uint8Array, subject: string): Generator<Uint8Array> {
  let start = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue
    yield bytes.subarray(start, index)
    start = index + 1
  }
  if (start !== bytes.length) throw new Error(`${subject} is not NUL terminated`)
}

/**
 * Test one ASCII prefix without decoding path-bearing Git output.
 * @param bytes - raw candidate bytes.
 * @param value - ASCII prefix.
 * @returns whether every prefix byte matches.
 */
export function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  if (bytes.length < value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[index] !== value.charCodeAt(index)) return false
  }
  return true
}
