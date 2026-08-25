/** Exact SQLite TEXT decoding and logical record-key encoding. @module */

import { TextDecoder } from 'node:util'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Encode any JavaScript string as canonical JSON string text before binding it
 * to SQLite. JSON escapes embedded NUL and unpaired UTF-16 surrogates, which
 * the SQLite text bridge cannot otherwise round-trip reliably.
 * @param key - Logical record key.
 * @returns canonical text with a one-to-one mapping back to the input string.
 */
export function encodeRecordKey(key: string): string {
  return JSON.stringify(key)
}

/**
 * Decode one physical-v2 record key from its exact stored UTF-8 bytes.
 * @param bytes - SQLite TEXT bytes selected through `CAST(key AS BLOB)`.
 * @returns the original logical JavaScript string.
 */
export function decodeRecordKey(bytes: Uint8Array): string {
  const stored = decodeSqliteText(bytes)
  let decoded: unknown
  try {
    decoded = JSON.parse(stored) as unknown
  } catch (error) {
    throw new Error('record key is not canonical JSON string text', { cause: error })
  }
  if (typeof decoded !== 'string' || JSON.stringify(decoded) !== stored) {
    throw new Error('record key is not canonical JSON string text')
  }
  // Canonical re-encoding is one-to-one: equal decoded keys have equal stored
  // TEXT, so the record table's primary key also guarantees logical uniqueness.
  return decoded
}

/**
 * Decode one legacy physical-v1 key without passing its TEXT through the
 * lossy SQLite-to-JavaScript string bridge.
 * @param bytes - SQLite TEXT bytes selected through `CAST(key AS BLOB)`.
 * @returns the exact stored UTF-8 string.
 */
export function decodeLegacyRecordKey(bytes: Uint8Array): string {
  return decodeSqliteText(bytes)
}

/**
 * Decode the exact bytes of a SQLite TEXT cell without replacement characters.
 * @param bytes - Cell bytes selected through `CAST(column AS BLOB)`.
 * @returns the exact UTF-8 string.
 */
export function decodeSqliteText(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch (error) {
    throw new Error('record key is not valid UTF-8 text', { cause: error })
  }
}
