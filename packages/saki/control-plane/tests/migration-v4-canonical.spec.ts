import { describe, expect, it } from 'vitest'
import { canonicalDigest, exactBytesDigest } from '@breakfastdapaidang/saki-execution'
import {
  v4CanonicalDigest,
  v4ExactBytesDigest,
} from '../src/migration-v4-canonical.ts'

const CANONICAL_GOLDEN = '055388ac7e6e33e1fdffcd9ab1c208fbc382782fe56fe69ebbb3a8a073c5c22d'
const EXACT_BYTES_GOLDEN = '070485eb75009a46f63893365c131538a38cd59f4fa317862d9ec139f2282cb9'
const EMPTY_CANONICAL_GOLDEN = 'f387a6754ef0e476eb5007471b999a2ca1cab036402c857257571b0a309604db'
const EMPTY_BYTES_GOLDEN = '3e7077fd2f66d689e0cee6a7cf5b37bf2dca7c979af356d0a31cbc5c85605c7d'

describe('frozen v4 canonical hashing', () => {
  it('matches the historical sorted-key JSON and framing bytes', () => {
    const value = {
      z: [3, null, { b: false, a: '雪' }],
      a: { omit: undefined, n: -0, t: true },
      m: 'line\n',
    }
    expect(v4CanonicalDigest('saki/v4-canonical-golden/v1', value)).toBe(CANONICAL_GOLDEN)
    expect(canonicalDigest('saki/v4-canonical-golden/v1', value)).toBe(CANONICAL_GOLDEN)
    expect(v4CanonicalDigest('', {})).toBe(EMPTY_CANONICAL_GOLDEN)
    expect(canonicalDigest('', {})).toBe(EMPTY_CANONICAL_GOLDEN)
  })

  it('matches the historical exact-byte framing', () => {
    const bytes = Uint8Array.of(0, 1, 2, 127, 128, 255)
    expect(v4ExactBytesDigest('saki/v4-exact-bytes-golden/v1', bytes)).toBe(EXACT_BYTES_GOLDEN)
    expect(exactBytesDigest('saki/v4-exact-bytes-golden/v1', bytes)).toBe(EXACT_BYTES_GOLDEN)
    expect(v4ExactBytesDigest('', new Uint8Array())).toBe(EMPTY_BYTES_GOLDEN)
    expect(exactBytesDigest('', new Uint8Array())).toBe(EMPTY_BYTES_GOLDEN)
  })
})
