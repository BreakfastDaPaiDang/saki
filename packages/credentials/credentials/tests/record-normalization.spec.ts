import { describe, expect, it } from 'vitest'
import { normalizeCredentialRecord, normalizeJsonValue } from '../src/record-normalization.ts'

const SUBJECT = 'test credential record'

describe('credential record normalization', () => {
  it('returns a detached plain-data snapshot without losing __proto__ or a literal toJSON field', () => {
    const payload = { nested: [{ toJSON: 'ordinary field', value: 1 }] }
    const env = Object.fromEntries([['__proto__', 'profile']])

    const normalized = normalizeCredentialRecord({ kind: 'grant', payload }, SUBJECT)
    const normalizedEnv = normalizeCredentialRecord({ kind: 'api-key', env }, SUBJECT)
    payload.nested[0]!.value = 2

    expect(normalized).toEqual({
      kind: 'grant',
      payload: { nested: [{ toJSON: 'ordinary field', value: 1 }] },
    })
    if (normalized.kind === 'grant') expect(normalized.payload).not.toBe(payload)
    expect(normalizedEnv).toEqual({ kind: 'api-key', env })
    expect(Object.hasOwn(normalizedEnv.kind === 'api-key' ? normalizedEnv.env ?? {} : {}, '__proto__')).toBe(true)
  })

  it('rejects values a JSON round trip would omit or reshape', () => {
    const sparse: unknown[] = []
    sparse.length = 1
    const extra = ['kept']
    Object.assign(extra, { omitted: true })
    const shiftedSparse: unknown[] = []
    shiftedSparse.length = 2
    shiftedSparse[1] = 'kept'
    Object.assign(shiftedSparse, { omitted: true })
    const nonEnumerableElement = ['kept']
    Object.defineProperty(nonEnumerableElement, '0', { value: 'kept', enumerable: false })
    const accessorElement = ['kept']
    Object.defineProperty(accessorElement, '0', { enumerable: true, get: () => 'kept' })
    const nonEnumerable = { visible: true }
    Object.defineProperty(nonEnumerable, 'omitted', { value: true })

    for (const value of [
      sparse,
      extra,
      shiftedSparse,
      nonEnumerableElement,
      accessorElement,
      nonEnumerable,
      { [Symbol('omitted')]: true },
      -0,
      Number.NaN,
      1n,
    ]) {
      expect(() => normalizeJsonValue(value, SUBJECT)).toThrow(TypeError)
    }
  })

  it('rejects inherited serializer state without invoking a Proxy prototype', () => {
    let trapCalls = 0
    const proxyPrototype = new Proxy({ toJSON: 'ordinary field' }, {
      getOwnPropertyDescriptor: () => {
        trapCalls++
        throw new Error('must not run')
      },
    })

    expect(() => normalizeJsonValue(Object.create(proxyPrototype), SUBJECT)).toThrow(TypeError)
    expect(() => normalizeJsonValue(Object.create({ toJSON: 'ordinary field' }), SUBJECT)).toThrow(TypeError)
    expect(trapCalls).toBe(0)
  })

  it('rejects executable properties and proxies without invoking user code or exposing trap errors', () => {
    const secret = 'LEAKED_SECRET'
    let getterCalls = 0
    let hookCalls = 0
    let trapCalls = 0
    const accessor = {}
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        getterCalls++
        throw new Error(secret)
      },
    })
    const hooked = { visible: true }
    Object.defineProperty(hooked, 'toJSON', {
      value: () => {
        hookCalls++
        throw new Error(secret)
      },
    })
    const proxied = new Proxy({ visible: true }, {
      ownKeys: () => {
        trapCalls++
        throw new Error(secret)
      },
    })

    for (const value of [accessor, hooked, proxied]) {
      const failure = (() => {
        try {
          normalizeJsonValue(value, SUBJECT)
        } catch (error) {
          return error as Error
        }
        return undefined
      })()
      expect(failure).toBeInstanceOf(TypeError)
      expect(failure?.message).not.toContain(secret)
      expect(failure?.cause).toBeUndefined()
    }
    expect([getterCalls, hookCalls, trapCalls]).toEqual([0, 0, 0])
  })

  it('requires the exact closed record union and stable api-key fields', () => {
    const invalid = [
      null,
      'grant',
      [],
      Object.create(null),
      { kind: 'grant', payload: {}, extra: true },
      { kind: 'grant' },
      { kind: 'api-key', key: 1 },
      { kind: 'api-key', key: 'token', env: {}, extra: true },
      { kind: 'api-key', extra: true },
      { kind: 'api-key', env: { 'not a name': 'value' } },
      { kind: 'api-key', env: { AWS_PROFILE: '' } },
      { kind: 'unknown', payload: {} },
    ]

    for (const value of invalid) {
      expect(() => normalizeCredentialRecord(value, SUBJECT)).toThrow(TypeError)
    }
  })
})
