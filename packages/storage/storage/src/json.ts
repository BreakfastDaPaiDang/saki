/** Exact JSON-value validation, cloning, and serialization shared by storage backends. @module */

import { parseTree, printParseErrorCode } from 'jsonc-parser'
import type { Node, ParseError } from 'jsonc-parser'

/**
 * Parse strict JSON while rejecting duplicate members and numeric tokens that
 * cannot survive a JavaScript parse/stringify round trip exactly.
 * @param text - Complete strict JSON source text.
 * @param subject - Human-readable document name used in diagnostics.
 * @returns the parsed exact JSON value.
 * @throws SyntaxError for invalid JSON or duplicate object members, and
 * TypeError for lossy numeric tokens.
 */
export function parseLosslessJsonValue(text: string, subject = 'JSON document'): unknown {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  })
  const first = errors[0]
  if (root === undefined || first !== undefined) {
    const detail = first === undefined
      ? 'empty document'
      : `${printParseErrorCode(first.error)} at offset ${first.offset}`
    throw new SyntaxError(`${subject} is not strict JSON: ${detail}`)
  }
  assertParsedNode(root, text, subject, '$')
  const value = JSON.parse(text) as unknown
  assertLosslessJsonValue(value, subject)
  return value
}

/**
 * Reject JavaScript values whose JSON encoding would change or omit data.
 * Accepted containers are dense ordinary arrays and plain data objects;
 * numbers must be finite and must not be negative zero.
 * @param value - Candidate value at a storage serialization boundary.
 * @param subject - Human-readable value name used in diagnostics.
 * @returns nothing after successful validation.
 * @throws TypeError when the value is not exact JSON data.
 */
export function assertLosslessJsonValue(value: unknown, subject = 'value'): void {
  assertValue(value, subject, new Set<object>())
}

/**
 * Serialize one exact JSON value after proving that encoding cannot omit or
 * coerce any part of it.
 * @param value - Candidate value at a storage serialization boundary.
 * @param subject - Human-readable value name used in diagnostics.
 * @param space - Optional JSON indentation width.
 * @returns the complete JSON encoding.
 * @throws TypeError when the value is not exact JSON data.
 */
export function stringifyLosslessJsonValue(value: unknown, subject = 'value', space?: number): string {
  assertLosslessJsonValue(value, subject)
  return JSON.stringify(value, null, space)
}

/**
 * Deep-clone one exact JSON value after rejecting data that JSON would omit or
 * coerce. The returned value shares no array or object references with the
 * input.
 * @param value - Candidate value at a storage ownership boundary.
 * @param subject - Human-readable value name used in diagnostics.
 * @returns a detached value with the same JSON data.
 * @throws TypeError when the value is not exact JSON data.
 */
export function cloneLosslessJsonValue<T>(value: T, subject = 'value'): T {
  return JSON.parse(stringifyLosslessJsonValue(value, subject)) as T
}

function assertValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`)
    if (Object.is(value, -0)) throw new TypeError(`${path} contains negative zero`)
    return
  }
  if (Array.isArray(value)) {
    assertArray(value, path, ancestors)
    return
  }
  if (!isPlainJsonObject(value)) throw new TypeError(`${path} is not a JSON value`)
  assertObject(value, path, ancestors)
}

function assertParsedNode(node: Node, text: string, subject: string, path: string): void {
  if (node.type === 'number') {
    assertLosslessNumberToken(node, text, subject, path)
    return
  }
  if (node.type === 'object') {
    const members = new Set<string>()
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0]
      const valueNode = property.children?.[1]
      if (keyNode?.type !== 'string' || typeof keyNode.value !== 'string' || valueNode === undefined) {
        throw new SyntaxError(`${subject} contains an incomplete object member at ${path}`)
      }
      if (members.has(keyNode.value)) {
        throw new SyntaxError(`${subject} repeats object member '${keyNode.value}' at ${path}`)
      }
      members.add(keyNode.value)
      assertParsedNode(valueNode, text, subject, `${path}.${keyNode.value}`)
    }
    return
  }
  if (node.type === 'array') {
    for (const [index, child] of (node.children ?? []).entries()) {
      assertParsedNode(child, text, subject, `${path}[${index}]`)
    }
  }
}

function assertLosslessNumberToken(node: Node, text: string, subject: string, path: string): void {
  const token = text.slice(node.offset, node.offset + node.length)
  const value: unknown = node.value
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new TypeError(`${subject} contains a lossy number '${token}' at ${path}`)
  }
  const encoded = JSON.stringify(value)
  if (canonicalDecimal(token) !== canonicalDecimal(encoded)) {
    throw new TypeError(`${subject} contains a lossy number '${token}' at ${path}`)
  }
}

function canonicalDecimal(token: string): string {
  const match = /^(?<sign>-?)(?<integer>0|[1-9]\d*)(?:\.(?<fraction>\d+))?(?:[eE](?<exponent>[+-]?\d+))?$/.exec(token)
  const groups = match?.groups
  if (groups === undefined) throw new SyntaxError(`invalid JSON number '${token}'`)
  const fraction = groups['fraction'] ?? ''
  let coefficient = `${groups['integer']}${fraction}`.replace(/^0+/, '')
  if (coefficient === '') return '0'
  let exponent = BigInt(groups['exponent'] ?? '0') - BigInt(fraction.length)
  while (coefficient.endsWith('0')) {
    coefficient = coefficient.slice(0, -1)
    exponent += 1n
  }
  return `${groups['sign']}${coefficient}e${exponent}`
}

function assertArray(value: unknown[], path: string, ancestors: Set<object>): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${path} is not an ordinary JSON array`)
  }
  enter(value, path, ancestors)
  try {
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || !keys.includes('length')) {
      throw new TypeError(`${path} is sparse or has non-JSON array properties`)
    }
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${path} is sparse or has accessor elements`)
      }
      assertValue(descriptor.value, `${path}[${index}]`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function assertObject(value: Record<string, unknown>, path: string, ancestors: Set<object>): void {
  enter(value, path, ancestors)
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError(`${path} has a symbol property`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${path}.${key} is not an enumerable data property`)
      }
      assertValue(descriptor.value, `${path}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function enter(value: object, path: string, ancestors: Set<object>): void {
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`)
  ancestors.add(value)
}

/**
 * Test whether a value is a plain JSON object container.
 * @param value - Candidate object value.
 * @returns `true` for ordinary and null-prototype objects, excluding arrays.
 */
export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}
