import { describe, expect, it } from 'vitest'
import {
  assertLosslessJsonValue,
  cloneLosslessJsonValue,
  parseLosslessJsonValue,
  stringifyLosslessJsonValue,
} from '../src/json.ts'

describe('lossless JSON values', () => {
  it('accepts exact JSON data including null-prototype records', () => {
    const record = Object.assign(Object.create(null) as Record<string, unknown>, {
      text: 'kept',
      nested: [null, true, 1.5],
    })
    expect(() => { assertLosslessJsonValue(record, 'record') }).not.toThrow()
    expect(stringifyLosslessJsonValue(record, 'record')).toBe('{"text":"kept","nested":[null,true,1.5]}')
  })

  it('deep-clones exact JSON data without retaining container references', () => {
    const source = { nested: { value: 'before' }, list: [{ value: 1 }] }
    const clone = cloneLosslessJsonValue(source, 'record')

    expect(clone).toEqual(source)
    expect(clone).not.toBe(source)
    expect(clone.nested).not.toBe(source.nested)
    expect(clone.list).not.toBe(source.list)
    expect(clone.list[0]).not.toBe(source.list[0])
    source.nested.value = 'after'
    source.list[0]!.value = 2
    expect(clone).toEqual({ nested: { value: 'before' }, list: [{ value: 1 }] })
  })

  it.each([
    ['undefined', { lost: undefined }],
    ['non-finite number', { changed: Number.POSITIVE_INFINITY }],
    ['negative zero', { changed: -0 }],
    ['sparse array', { changed: Array(1) }],
    ['array property', Object.assign([], { extra: true })],
    ['exotic object', { changed: new Date(0) }],
    ['symbol property', Object.assign({}, { [Symbol('lost')]: true })],
    ['exotic array', Object.setPrototypeOf([], Object.create(Array.prototype) as object)],
    ['array accessor', Object.defineProperty([1], '0', { enumerable: true, get: () => 1 })],
  ] as readonly (readonly [string, unknown])[])('rejects %s before serialization', (_label, value) => {
    expect(() => stringifyLosslessJsonValue(value, 'record')).toThrow(TypeError)
    expect(() => cloneLosslessJsonValue(value, 'record')).toThrow(TypeError)
  })

  it('rejects accessors and cycles', () => {
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 })
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    expect(() => { assertLosslessJsonValue(accessor) }).toThrow(/data property/)
    expect(() => { assertLosslessJsonValue(cycle) }).toThrow(/cycle/)
  })

  it('parses strict JSON without losing exact numeric lexemes', () => {
    const parsed = parseLosslessJsonValue('{"whole":1e3,"decimal":1.2300,"small":1e-25,"list":[1]}')
    expect(parsed)
      .toEqual({ whole: 1000, decimal: 1.23, small: 1e-25, list: [1] })
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
  })

  it('preserves __proto__ as an ordinary own JSON member', () => {
    const parsed = parseLosslessJsonValue('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true)
    expect(parsed['__proto__']).toEqual({ polluted: true })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it.each([
    ['empty document', ''],
    ['nested duplicate member', '{"outer":{"same":1,"same":2}}'],
    ['unsafe integer', '{"value":9007199254740993}'],
    ['numeric underflow', '{"value":1e-4000}'],
    ['numeric overflow', '{"value":1e400}'],
    ['byte-order mark', '\uFEFF{"value":1}'],
    ['comment', '{"value":1/* comment */}'],
    ['trailing comma', '{"value":1,}'],
  ])('rejects %s while parsing strict lossless JSON', (_label, text) => {
    expect(() => parseLosslessJsonValue(text, 'stored document')).toThrow()
  })
})
