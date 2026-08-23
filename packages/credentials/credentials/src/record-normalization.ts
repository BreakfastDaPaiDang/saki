/**
 * Provider-facing normalization for credential records crossing durable
 * storage. This Node-only entry inspects property descriptors without invoking
 * caller code and returns fresh plain data that serializers may read safely.
 * @module @deepseek-ai/dsh-credentials/record-normalization
 */

import { isProxy } from 'node:util/types'
import { credentialRef } from './credential-ref.ts'
import type { CredentialRecord } from './types.ts'

interface DataObjectSnapshot {
  isArray: boolean
  prototype: object | null
  properties: ReadonlyMap<string, PropertyDescriptor>
}

/** Run one reflective data read without retaining hostile trap details. */
function inspectValue<T>(subject: string, inspect: () => T): T {
  try {
    return inspect()
  } catch {
    throw new TypeError(`${subject} cannot be inspected as JSON data`)
  }
}

/** Reject an inherited serializer hook, stopping at the first property that shadows it. */
function assertNoInheritedToJson(subject: string, prototype: object | null): void {
  let current = prototype
  while (current !== null) {
    if (isProxy(current)) throw new TypeError(`${subject} cannot be inspected as JSON data`)
    const inspected = current
    const descriptor = inspectValue(subject, () => Object.getOwnPropertyDescriptor(inspected, 'toJSON'))
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value === 'function') {
        throw new TypeError(`${subject} exposes executable toJSON`)
      }
      return
    }
    current = inspectValue(subject, () => Reflect.getPrototypeOf(inspected))
  }
}

/** Capture one object's complete own-property state without invoking user code. */
function inspectDataObject(subject: string, value: object): DataObjectSnapshot {
  if (isProxy(value)) throw new TypeError(`${subject} cannot be inspected as JSON data`)
  const isArray = inspectValue(subject, () => Array.isArray(value))
  const prototype = inspectValue(subject, () => Reflect.getPrototypeOf(value))
  const keys = inspectValue(subject, () => Reflect.ownKeys(value))
  const properties = new Map<string, PropertyDescriptor>()
  for (const property of keys) {
    if (typeof property !== 'string') throw new TypeError(`${subject} holds a symbol-keyed property`)
    const descriptor = inspectValue(subject, () => Object.getOwnPropertyDescriptor(value, property))
    if (descriptor === undefined) throw new TypeError(`${subject} cannot be inspected as JSON data`)
    properties.set(property, descriptor)
  }
  const ownToJson = properties.get('toJSON')
  if (ownToJson === undefined) assertNoInheritedToJson(subject, prototype)
  else if (!('value' in ownToJson) || typeof ownToJson.value === 'function') {
    throw new TypeError(`${subject} exposes executable toJSON`)
  }
  return { isArray, prototype, properties }
}

/** Normalize one JSON value recursively. */
function normalizeNestedJsonValue(subject: string, value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Object.is(value, -0)) throw new TypeError(`${subject} holds -0, which serialization converts to 0`)
    if (Number.isFinite(value)) return value
    throw new TypeError(`${subject} holds a non-finite number`)
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError(`${subject} is cyclic`)
    const snapshot = inspectDataObject(subject, value)
    if (snapshot.isArray) {
      if (snapshot.prototype !== Array.prototype) {
        throw new TypeError(`${subject} holds an array serialization cannot reproduce`)
      }
      const lengthDescriptor = snapshot.properties.get('length')
      if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
        || typeof lengthDescriptor.value !== 'number' || lengthDescriptor.enumerable
        || snapshot.properties.size !== lengthDescriptor.value + 1) {
        throw new TypeError(`${subject} holds an array serialization cannot reproduce`)
      }
      let index = 0
      for (const [property, descriptor] of snapshot.properties) {
        if (property === 'length') continue
        if (property !== String(index) || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError(`${subject} holds an array serialization cannot reproduce`)
        }
        index++
      }
      seen.add(value)
      const normalized: unknown[] = []
      for (const [property, descriptor] of snapshot.properties) {
        if (property === 'length') continue
        normalized.push(normalizeNestedJsonValue(subject, descriptor.value, seen))
      }
      seen.delete(value)
      return normalized
    }
    if (snapshot.prototype === Object.prototype) {
      const normalized: Record<string, unknown> = {}
      seen.add(value)
      for (const [property, descriptor] of snapshot.properties) {
        if (!descriptor.enumerable) throw new TypeError(`${subject} holds a non-enumerable property`)
        if (!('value' in descriptor)) throw new TypeError(`${subject} holds an enumerable accessor`)
        Object.defineProperty(normalized, property, {
          value: normalizeNestedJsonValue(subject, descriptor.value, seen),
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      seen.delete(value)
      return normalized
    }
  }
  throw new TypeError(`${subject} holds a value JSON cannot represent`)
}

/** Return a plain mapping's enumerable data fields, rejecting every other own-property form. */
function dataFields(subject: string, value: unknown): ReadonlyMap<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${subject} must be a plain data object`)
  }
  const snapshot = inspectDataObject(subject, value)
  if (snapshot.isArray || snapshot.prototype !== Object.prototype) {
    throw new TypeError(`${subject} must be a plain data object`)
  }
  const fields = new Map<string, unknown>()
  for (const [name, descriptor] of snapshot.properties) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${subject} must contain only enumerable data fields`)
    }
    fields.set(name, descriptor.value)
  }
  return fields
}

/** Normalize an api-key environment mapping without invoking or retaining it. */
function normalizeRecordEnv(subject: string, value: unknown): Record<string, string> {
  const fields = dataFields(`${subject} env`, value)
  const env: Record<string, string> = {}
  for (const [name, field] of fields) {
    try {
      credentialRef(name)
    } catch {
      throw new TypeError(`${subject} env contains an invalid name that must match the credential reference grammar`)
    }
    if (typeof field !== 'string' || field.length === 0) {
      throw new TypeError(`${subject} env contains a value that is not a non-empty string`)
    }
    Object.defineProperty(env, name, { value: field, enumerable: true, configurable: true, writable: true })
  }
  return env
}

/**
 * Snapshot a runtime value into fresh JSON data without invoking accessors,
 * serializer hooks, or Proxy traps. The subject is copied into diagnostics and
 * therefore must identify the storage location without containing credential data.
 * @param value - runtime value about to cross or enter durable storage.
 * @param subject - safe diagnostic subject, excluding all credential values.
 * @returns a primitive or a fresh graph of plain objects and native arrays.
 * @throws TypeError when the value cannot survive a JSON round trip exactly.
 */
export function normalizeJsonValue(value: unknown, subject: string): unknown {
  return normalizeNestedJsonValue(subject, value, new Set())
}

/**
 * Validate and clone the closed credential-record union without invoking or
 * retaining the caller's objects. The subject is copied into diagnostics and
 * therefore must identify the record without containing credential data.
 * @param value - candidate credential record at a durable storage operation.
 * @param subject - safe diagnostic subject, excluding all credential values.
 * @returns a fresh record whose environment and payload contain only plain data.
 * @throws TypeError when the record or any nested value cannot round-trip exactly.
 */
export function normalizeCredentialRecord(value: unknown, subject: string): CredentialRecord {
  const fields = dataFields(subject, value)
  const kind = fields.get('kind')
  if (kind === 'grant') {
    if (fields.size !== 2 || !fields.has('payload')) {
      throw new TypeError(`${subject} has invalid grant fields`)
    }
    return { kind, payload: normalizeJsonValue(fields.get('payload'), `${subject} payload`) }
  }
  if (kind === 'api-key') {
    if (fields.size > 3 || [...fields.keys()].some(name => name !== 'kind' && name !== 'key' && name !== 'env')) {
      throw new TypeError(`${subject} has invalid api-key fields`)
    }
    let apiKey: string | undefined
    if (fields.has('key')) {
      const field = fields.get('key')
      if (typeof field !== 'string' || field.length === 0) {
        throw new TypeError(`${subject} has an empty key or a non-string key`)
      }
      apiKey = field
    }
    const env = fields.has('env') ? normalizeRecordEnv(subject, fields.get('env')) : undefined
    return {
      kind,
      ...apiKey === undefined ? {} : { key: apiKey },
      ...env === undefined ? {} : { env },
    }
  }
  throw new TypeError(`${subject} has an unknown kind`)
}
