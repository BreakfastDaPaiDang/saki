import { describe, expect, it } from 'vitest'
import { decodeGitLine } from '../src/commit-inspection.ts'

describe('exact Commit process output', () => {
  it.each([
    { name: 'LF', bytes: Buffer.from('abc\n'), expected: 'abc' },
    { name: 'CRLF', bytes: Buffer.from('abc\r\n'), expected: 'abc' },
    { name: 'missing terminator', bytes: Buffer.from('abc'), expected: undefined },
    { name: 'multiple lines', bytes: Buffer.from('abc\ndef\n'), expected: undefined },
    { name: 'invalid UTF-8', bytes: Buffer.from([0xff]), expected: undefined },
  ])('decodes $name without accepting trailing process output', ({ bytes, expected }) => {
    expect(decodeGitLine(bytes)).toBe(expected)
  })
})
