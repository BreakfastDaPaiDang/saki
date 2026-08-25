/** Browser-safe canonical hashing for Saki value semantics. @module @breakfastdapaidang/saki-execution/canonical */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const UTF8 = new TextEncoder()

/**
 * Hash one domain-separated value through deterministic sorted-key JSON.
 * @param domain - versioned digest domain.
 * @param value - JSON-compatible value to encode.
 * @returns lowercase SHA-256 digest.
 */
export function canonicalDigest(domain: string, value: unknown): string {
  return framedDigest(domain, UTF8.encode(canonicalJson(value)))
}

/**
 * Hash exact bytes with an unambiguous domain and length frame.
 * @param domain - versioned digest domain.
 * @param bytes - exact bytes to frame and hash.
 * @returns lowercase SHA-256 digest.
 */
export function exactBytesDigest(domain: string, bytes: Uint8Array): string {
  return framedDigest(domain, bytes)
}

/**
 * Compare text by UTF-16 code units independently of locale and ICU data.
 * @param left - first text value.
 * @param right - second text value.
 * @returns negative, zero, or positive ordering result.
 */
export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function framedDigest(domain: string, payload: Uint8Array): string {
  const length = new Uint8Array(8)
  new DataView(length.buffer).setBigUint64(0, BigInt(payload.byteLength))
  return bytesToHex(sha256.create()
    .update(UTF8.encode(domain))
    .update(Uint8Array.of(0))
    .update(length)
    .update(payload)
    .digest())
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => compareCanonicalText(left, right))
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`
  }
  throw new Error(`canonical JSON rejects ${typeof value}`)
}
