/**
 * Frozen canonical hashing retained by the exact Saki control-plane v4 reader.
 * @module @breakfastdapaidang/saki-control-plane/src/migration-v4-canonical
 */

import { createHash } from 'node:crypto'

const UTF8 = new TextEncoder()

/**
 * Hash one v4 domain-separated value through the historical sorted-key JSON encoding.
 * @param domain - historical versioned digest domain.
 * @param value - JSON-compatible value to encode.
 * @returns lowercase SHA-256 digest.
 */
export function v4CanonicalDigest(domain: string, value: unknown): string {
  return framedDigest(domain, UTF8.encode(canonicalJson(value)))
}

/**
 * Hash exact bytes with the historical v4 domain and length frame.
 * @param domain - historical versioned digest domain.
 * @param bytes - exact bytes to frame and hash.
 * @returns lowercase SHA-256 digest.
 */
export function v4ExactBytesDigest(domain: string, bytes: Uint8Array): string {
  return framedDigest(domain, bytes)
}

function framedDigest(domain: string, payload: Uint8Array): string {
  const length = new Uint8Array(8)
  new DataView(length.buffer).setBigUint64(0, BigInt(payload.byteLength))
  return createHash('sha256')
    .update(UTF8.encode(domain))
    .update(Uint8Array.of(0))
    .update(length)
    .update(payload)
    .digest('hex')
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
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`
  }
  throw new Error(`canonical JSON rejects ${typeof value}`)
}
