import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalDigest, compareCanonicalText, exactBytesDigest } from '../src/canonical.ts'

describe('canonical observation encoding', () => {
  it('orders object keys by deterministic code units instead of the Host locale', () => {
    const payload = Buffer.from('{"Z":1,"a":2}', 'utf8')
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(payload.byteLength))
    const expected = createHash('sha256')
      .update(Buffer.from('test/canonical/v1', 'utf8'))
      .update(Buffer.from([0]))
      .update(length)
      .update(payload)
      .digest('hex')

    expect(canonicalDigest('test/canonical/v1', { a: 2, Z: 1 })).toBe(expected)
  })

  it('closes canonical JSON values and text ordering', () => {
    expect(compareCanonicalText('a', 'b')).toBe(-1)
    expect(compareCanonicalText('b', 'a')).toBe(1)
    expect(compareCanonicalText('a', 'a')).toBe(0)
    expect(canonicalDigest('test/canonical/v1', [null, 'text', true, { omitted: undefined }]))
      .toMatch(/^[0-9a-f]{64}$/u)
    expect(exactBytesDigest('test/exact/v1', Uint8Array.of(0, 1, 2))).toMatch(/^[0-9a-f]{64}$/u)
    expect(() => canonicalDigest('test/canonical/v1', Number.NaN)).toThrow('non-finite')
    expect(() => canonicalDigest('test/canonical/v1', undefined)).toThrow('rejects undefined')
  })
})
