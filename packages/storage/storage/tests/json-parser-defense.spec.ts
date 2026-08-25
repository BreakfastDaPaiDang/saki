import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node } from 'jsonc-parser'

const parser = vi.hoisted(() => vi.fn<() => Node | undefined>())

vi.mock('jsonc-parser', async importOriginal => ({
  ...await importOriginal<typeof import('jsonc-parser')>(),
  parseTree: parser,
}))

import { parseLosslessJsonValue } from '../src/json.ts'

function parsedNode(type: Node['type'], values: Partial<Node> = {}): Node {
  return { type, offset: 0, length: 2, ...values }
}

describe('lossless JSON parse-tree defenses', () => {
  beforeEach(() => { parser.mockReset() })

  it('rejects a missing parser root without a reported parse error', () => {
    parser.mockReturnValue(undefined)
    expect(() => parseLosslessJsonValue('', 'stored document')).toThrow('empty document')
  })

  it.each([
    ['object', '{}'],
    ['array', '[]'],
  ] as const)('accepts an empty %s node whose parser omits children', (type, text) => {
    parser.mockReturnValue(parsedNode(type))
    expect(parseLosslessJsonValue(text)).toEqual(JSON.parse(text))
  })

  it('rejects an incomplete parser object member', () => {
    parser.mockReturnValue(parsedNode('object', {
      children: [parsedNode('property', {
        children: [parsedNode('string', { value: 'key' })],
      })],
    }))
    expect(() => parseLosslessJsonValue('{}', 'stored document')).toThrow('incomplete object member')
  })

  it('rejects a parser number node whose token is not a JSON number', () => {
    parser.mockReturnValue(parsedNode('number', { length: 1, value: 1 }))
    expect(() => parseLosslessJsonValue('x', 'stored document')).toThrow("invalid JSON number 'x'")
  })
})
