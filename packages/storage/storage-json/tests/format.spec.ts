import { describe, expect, it } from 'vitest'
import { parseStoredJsonUnit, validateDescriptor } from '../src/format.ts'

describe('JSON physical format validation', () => {
  it.each([
    ['null', null],
    ['an array', []],
  ])('rejects %s as the complete table map', (_label, tables) => {
    expect(() => parseStoredJsonUnit(JSON.stringify({
      unit: { name: 'unit', version: 1, formatVersion: 1, hasGlobal: false },
      global: null,
      tables,
    }), 'unit')).toThrow(/tables is not an object/)
  })

  it('rejects stored global data when the header declares no global slot', () => {
    expect(() => parseStoredJsonUnit(JSON.stringify({
      unit: { name: 'unit', version: 1, formatVersion: 1, hasGlobal: false },
      global: { undeclared: true },
      tables: {},
    }), 'unit')).toThrow(/stored global is present without a declared global slot/)
  })

  it('rejects duplicate declared tables', () => {
    expect(() => {
      validateDescriptor({
        name: 'unit', version: 1, tables: ['records', 'records'], hasGlobal: false,
      })
    }).toThrow(/descriptor repeats a table name/)
  })
})
