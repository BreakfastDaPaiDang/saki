/**
 * Minimal CNG DPAPI adapter for an explicit `LOCAL=user` protection descriptor.
 * Decryption verifies the descriptor carried by the protected blob before any
 * plaintext copy reaches JavaScript. Native data allocations are overwritten
 * before `LocalFree`; descriptor handles and rule strings use their documented
 * Windows release operations.
 * @module @deepseek-ai/dsh-credentials-windows-dpapi/dpapi
 */

import koffi from 'koffi'
import { isUtf8 } from 'node:buffer'

const CURRENT_USER_DESCRIPTOR = 'LOCAL=user'
const NCRYPT_SILENT_FLAG = 0x40
const NCRYPT_PROTECTION_INFO_TYPE_DESCRIPTOR_STRING = 1

type NativePtr = bigint
type Ptr = ReturnType<typeof koffi.pointer>

interface NativeOutput {
  pointer: NativePtr | null
  length: number
}

interface DescriptorOutput {
  handle: NativePtr | null
}

interface DescriptorRuleOutput {
  pointer: NativePtr | null
}

/** Native operations used by the CNG DPAPI adapter; separated for fail-path verification. */
export interface DpapiBindings {
  /**
   * Create one protection descriptor handle.
   * @param rule - complete CNG DPAPI descriptor rule.
   * @param output - receives the descriptor handle.
   * @returns Windows security status; zero means success.
   */
  createDescriptor(rule: string, output: DescriptorOutput): number
  /**
   * Protect bytes with one descriptor handle.
   * @param descriptor - descriptor returned by `createDescriptor`.
   * @param input - non-empty bytes to protect.
   * @param output - receives the Windows-owned protected blob.
   * @returns Windows security status; zero means success.
   */
  protect(descriptor: NativePtr, input: Buffer, output: NativeOutput): number
  /**
   * Unprotect one blob and return both its embedded descriptor and plaintext allocation.
   * @param input - opaque protected blob.
   * @param descriptor - receives the descriptor carried by the blob.
   * @param output - receives the Windows-owned plaintext.
   * @returns Windows security status; zero means success.
   */
  unprotect(input: Buffer, descriptor: DescriptorOutput, output: NativeOutput): number
  /**
   * Allocate one descriptor's complete rule string.
   * @param descriptor - live protection descriptor handle.
   * @param output - receives the Windows-owned UTF-16 rule allocation.
   * @returns Windows security status; zero means success.
   */
  getDescriptorRule(descriptor: NativePtr, output: DescriptorRuleOutput): number
  /**
   * Decode one live UTF-16 rule allocation.
   * @param pointer - allocation returned by `getDescriptorRule`.
   * @returns complete descriptor rule string.
   */
  decodeDescriptorRule(pointer: NativePtr): string
  /**
   * Release one protection descriptor handle.
   * @param descriptor - live descriptor handle.
   * @returns Windows security status; zero means success.
   */
  closeDescriptor(descriptor: NativePtr): number
  /**
   * Overwrite one Windows-owned allocation before release.
   * @param pointer - allocation start.
   * @param length - allocation byte count, including zero-length results.
   */
  secureZeroMemory(pointer: NativePtr, length: number): void
  /**
   * Release one Windows-owned allocation.
   * @param pointer - allocation returned by CNG DPAPI.
   * @returns null on success, or the unreleased pointer on failure.
   */
  localFree(pointer: NativePtr): NativePtr | null
  /**
   * View a native allocation without assuming JS ownership.
   * @param pointer - native allocation start.
   * @param length - byte count to expose.
   * @returns byte view valid until the allocation is freed.
   */
  view(pointer: NativePtr, length: number): Uint8Array
}

const PBYTE: Ptr = koffi.pointer('uint8')
const PVOID: Ptr = koffi.pointer('void')

/** Load the CNG DPAPI functions only when a credential operation needs them. */
function bindings(): DpapiBindings {
  /* v8 ignore next 2 -- Linux executes the non-Windows rejection peer; native Windows coverage executes the bindings. */
  if (process.platform !== 'win32') {
    throw new Error('credentials-windows-dpapi requires Windows')
  }
  const ncrypt = koffi.load('ncrypt.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const localFree = kernel32.func('__stdcall', 'LocalFree', PVOID, [PVOID]) as unknown as
    (pointer: NativePtr) => NativePtr | null
  const createDescriptor = ncrypt.func('__stdcall', 'NCryptCreateProtectionDescriptor', 'int32', [
    'str16', 'uint32', koffi.out(koffi.pointer('void', 2)),
  ]) as unknown as (rule: string, flags: number, output: [NativePtr | null]) => number
  const protect = ncrypt.func('__stdcall', 'NCryptProtectSecret', 'int32', [
    PVOID, 'uint32', PBYTE, 'uint32', PVOID, PVOID,
    koffi.out(koffi.pointer('uint8', 2)), koffi.out(koffi.pointer('uint32')),
  ]) as unknown as (
    descriptor: NativePtr, flags: number, input: Buffer, length: number,
    allocation: null, window: null, output: [NativePtr | null], outputLength: [number],
  ) => number
  const unprotect = ncrypt.func('__stdcall', 'NCryptUnprotectSecret', 'int32', [
    koffi.out(koffi.pointer('void', 2)), 'uint32', PBYTE, 'uint32', PVOID, PVOID,
    koffi.out(koffi.pointer('uint8', 2)), koffi.out(koffi.pointer('uint32')),
  ]) as unknown as (
    descriptor: [NativePtr | null], flags: number, input: Buffer, length: number,
    allocation: null, window: null, output: [NativePtr | null], outputLength: [number],
  ) => number
  const getDescriptorRule = ncrypt.func('__stdcall', 'NCryptGetProtectionDescriptorInfo', 'int32', [
    PVOID, PVOID, 'uint32', koffi.out(koffi.pointer('void', 2)),
  ]) as unknown as (
    descriptor: NativePtr, allocation: null, infoType: number, output: [NativePtr | null],
  ) => number
  const closeDescriptor = ncrypt.func('__stdcall', 'NCryptCloseProtectionDescriptor', 'int32', [PVOID]) as unknown as
    (descriptor: NativePtr) => number
  const utf16Length = kernel32.func('__stdcall', 'lstrlenW', 'int32', [PVOID]) as unknown as
    (value: NativePtr) => number
  return {
    createDescriptor: (rule, output) => {
      const nativeOutput: [NativePtr | null] = [null]
      const status = createDescriptor(rule, 0, nativeOutput)
      output.handle = nativeOutput[0]
      return status
    },
    protect: (descriptor, input, output) => {
      const pointer: [NativePtr | null] = [null]
      const length: [number] = [0]
      const status = protect(
        descriptor,
        NCRYPT_SILENT_FLAG,
        input,
        input.length,
        null,
        null,
        pointer,
        length,
      )
      output.pointer = pointer[0]
      output.length = length[0]
      return status
    },
    unprotect: (input, descriptor, output) => {
      const nativeDescriptor: [NativePtr | null] = [null]
      const pointer: [NativePtr | null] = [null]
      const length: [number] = [0]
      const status = unprotect(
        nativeDescriptor,
        NCRYPT_SILENT_FLAG,
        input,
        input.length,
        null,
        null,
        pointer,
        length,
      )
      descriptor.handle = nativeDescriptor[0]
      output.pointer = pointer[0]
      output.length = length[0]
      return status
    },
    getDescriptorRule: (descriptor, output) => {
      const nativeOutput: [NativePtr | null] = [null]
      const status = getDescriptorRule(
        descriptor,
        null,
        NCRYPT_PROTECTION_INFO_TYPE_DESCRIPTOR_STRING,
        nativeOutput,
      )
      output.pointer = nativeOutput[0]
      return status
    },
    decodeDescriptorRule: (pointer) => {
      const length = utf16Length(pointer)
      return Buffer.from(koffi.view(pointer, length * 2)).toString('utf16le')
    },
    closeDescriptor,
    secureZeroMemory: (pointer, length) => {
      new Uint8Array(koffi.view(pointer, length)).fill(0)
    },
    localFree,
    view: (pointer, length) => new Uint8Array(koffi.view(pointer, length)),
  }
}

/** Render one CNG security status without interpreting provider-specific codes. */
function statusText(status: number): string {
  return String(status >>> 0)
}

/** Invoke one native operation without retaining an arbitrary binding exception. */
function invoke(operation: string, call: () => number): number {
  try {
    return call()
  } catch {
    throw new Error(`credentials-windows-dpapi: ${operation} invocation failed`)
  }
}

/** Close one descriptor and surface cleanup failure without a native cause. */
function closeDescriptor(api: DpapiBindings, operation: string, descriptor: NativePtr): void {
  const status = invoke('NCryptCloseProtectionDescriptor', () => api.closeDescriptor(descriptor))
  if (status !== 0) {
    throw new Error(
      `credentials-windows-dpapi: NCryptCloseProtectionDescriptor failed after ${operation} with status ${statusText(status)}`,
    )
  }
}

/** Overwrite and free one returned allocation, including non-null zero-length results. */
function wipeAndFree(api: DpapiBindings, operation: string, output: NativeOutput): void {
  const pointer = output.pointer
  if (pointer === null || pointer === 0n) return
  const length = output.length
  output.pointer = null
  output.length = 0
  let zeroFailed = false
  try {
    api.secureZeroMemory(pointer, length)
  } catch {
    zeroFailed = true
  }
  let notFreed: NativePtr | null
  try {
    notFreed = api.localFree(pointer)
  } catch {
    throw new Error(`credentials-windows-dpapi: LocalFree invocation failed after ${operation}`)
  }
  if (notFreed !== null && notFreed !== 0n) {
    throw new Error(`credentials-windows-dpapi: LocalFree failed after ${operation}`)
  }
  if (zeroFailed) {
    throw new Error(`credentials-windows-dpapi: native output zeroization failed after ${operation}`)
  }
}

/** Copy one non-empty returned allocation, then overwrite and free the native bytes. */
function takeOutput(api: DpapiBindings, operation: string, output: NativeOutput): Buffer {
  const pointer = output.pointer
  if (pointer === null || pointer === 0n) {
    throw new Error(`credentials-windows-dpapi: ${operation} returned an empty result`)
  }
  let result: Buffer | undefined
  try {
    if (output.length > 0) {
      try {
        result = Buffer.from(api.view(pointer, output.length))
      } catch {
        throw new Error(`credentials-windows-dpapi: cannot copy ${operation} output`)
      }
    }
  } finally {
    try {
      wipeAndFree(api, operation, output)
    } catch (error) {
      result?.fill(0)
      throw error
    }
  }
  if (result === undefined) {
    throw new Error(`credentials-windows-dpapi: ${operation} returned an empty result`)
  }
  return result
}

/** Create and close one descriptor around an operation that returns sensitive bytes. */
function withDescriptor(api: DpapiBindings, rule: string, operation: (descriptor: NativePtr) => Buffer): Buffer {
  const output: DescriptorOutput = { handle: null }
  let status: number
  try {
    status = invoke('NCryptCreateProtectionDescriptor', () => api.createDescriptor(rule, output))
  } catch (error) {
    const returnedDescriptor = output.handle
    if (returnedDescriptor !== null && returnedDescriptor !== 0n) {
      closeDescriptor(api, 'NCryptCreateProtectionDescriptor', returnedDescriptor)
    }
    throw error
  }
  const descriptor = output.handle
  if (status !== 0) {
    if (descriptor !== null && descriptor !== 0n) closeDescriptor(api, 'NCryptCreateProtectionDescriptor', descriptor)
    throw new Error(
      `credentials-windows-dpapi: NCryptCreateProtectionDescriptor failed with status ${statusText(status)}`,
    )
  }
  if (descriptor === null || descriptor === 0n) {
    throw new Error('credentials-windows-dpapi: NCryptCreateProtectionDescriptor returned no handle')
  }
  let result: Buffer | undefined
  try {
    result = operation(descriptor)
    return result
  } finally {
    try {
      closeDescriptor(api, 'NCryptProtectSecret', descriptor)
    } catch (error) {
      result?.fill(0)
      throw error
    }
  }
}

/** Protect bytes under the one accepted current-user descriptor. */
function protectBuffer(api: DpapiBindings, input: Buffer): Buffer {
  return withDescriptor(api, CURRENT_USER_DESCRIPTOR, (descriptor) => {
    const output: NativeOutput = { pointer: null, length: 0 }
    let status: number
    try {
      status = invoke('NCryptProtectSecret', () => api.protect(descriptor, input, output))
    } catch (error) {
      wipeAndFree(api, 'NCryptProtectSecret', output)
      throw error
    }
    if (status !== 0) {
      wipeAndFree(api, 'NCryptProtectSecret', output)
      throw new Error(`credentials-windows-dpapi: NCryptProtectSecret failed with status ${statusText(status)}`)
    }
    return takeOutput(api, 'NCryptProtectSecret', output)
  })
}

/** Release one non-secret descriptor rule allocation. */
function freeDescriptorRule(api: DpapiBindings, output: DescriptorRuleOutput): void {
  const pointer = output.pointer
  if (pointer === null || pointer === 0n) return
  output.pointer = null
  let notFreed: NativePtr | null
  try {
    notFreed = api.localFree(pointer)
  } catch {
    throw new Error('credentials-windows-dpapi: LocalFree invocation failed after descriptor inspection')
  }
  if (notFreed !== null && notFreed !== 0n) {
    throw new Error('credentials-windows-dpapi: LocalFree failed after descriptor inspection')
  }
}

/** Read and release one Windows-owned complete descriptor rule. */
function readDescriptorRule(api: DpapiBindings, descriptor: NativePtr): string {
  const output: DescriptorRuleOutput = { pointer: null }
  let status: number
  try {
    status = invoke('NCryptGetProtectionDescriptorInfo', () => api.getDescriptorRule(descriptor, output))
  } catch (error) {
    freeDescriptorRule(api, output)
    throw error
  }
  if (status !== 0) {
    freeDescriptorRule(api, output)
    throw new Error(
      `credentials-windows-dpapi: NCryptGetProtectionDescriptorInfo failed with status ${statusText(status)}`,
    )
  }
  const pointer = output.pointer
  if (pointer === null || pointer === 0n) {
    throw new Error('credentials-windows-dpapi: NCryptGetProtectionDescriptorInfo returned no rule')
  }
  try {
    try {
      return api.decodeDescriptorRule(pointer)
    } catch {
      throw new Error('credentials-windows-dpapi: cannot decode the protection descriptor')
    }
  } finally {
    freeDescriptorRule(api, output)
  }
}

/** Unprotect bytes only after the blob's authenticated descriptor is exactly `LOCAL=user`. */
function unprotectBuffer(api: DpapiBindings, input: Buffer): Buffer {
  const descriptorOutput: DescriptorOutput = { handle: null }
  const output: NativeOutput = { pointer: null, length: 0 }
  let status: number
  try {
    status = invoke('NCryptUnprotectSecret', () => api.unprotect(input, descriptorOutput, output))
  } catch (error) {
    try {
      wipeAndFree(api, 'NCryptUnprotectSecret', output)
    } finally {
      const returnedDescriptor = descriptorOutput.handle
      if (returnedDescriptor !== null && returnedDescriptor !== 0n) {
        closeDescriptor(api, 'NCryptUnprotectSecret', returnedDescriptor)
      }
    }
    throw error
  }
  const descriptor = descriptorOutput.handle
  if (status !== 0) {
    try {
      wipeAndFree(api, 'NCryptUnprotectSecret', output)
    } finally {
      if (descriptor !== null && descriptor !== 0n) closeDescriptor(api, 'NCryptUnprotectSecret', descriptor)
    }
    throw new Error(`credentials-windows-dpapi: NCryptUnprotectSecret failed with status ${statusText(status)}`)
  }
  if (descriptor === null || descriptor === 0n) {
    wipeAndFree(api, 'NCryptUnprotectSecret', output)
    throw new Error('credentials-windows-dpapi: NCryptUnprotectSecret returned no descriptor')
  }
  let result: Buffer | undefined
  try {
    const rule = readDescriptorRule(api, descriptor)
    if (rule !== CURRENT_USER_DESCRIPTOR) {
      wipeAndFree(api, 'NCryptUnprotectSecret', output)
      throw new Error('credentials-windows-dpapi: protected blob is not scoped to the current Windows user')
    }
    result = takeOutput(api, 'NCryptUnprotectSecret', output)
    return result
  } catch (error) {
    if (output.pointer !== null && output.pointer !== 0n) wipeAndFree(api, 'NCryptUnprotectSecret', output)
    throw error
  } finally {
    try {
      closeDescriptor(api, 'NCryptUnprotectSecret', descriptor)
    } catch (error) {
      result?.fill(0)
      throw error
    }
  }
}

/** Current-user protection operations used by the file Provider. */
export interface DpapiProtection {
  /**
   * Encrypt one non-empty UTF-8 value to canonical base64.
   * @param value - plaintext credential value.
   * @returns opaque CNG DPAPI `LOCAL=user` ciphertext.
   */
  protect(value: string): string
  /**
   * Decrypt one canonical base64 `LOCAL=user` ciphertext.
   * @param ciphertext - opaque CNG DPAPI ciphertext.
   * @returns plaintext credential value.
   */
  unprotect(ciphertext: string): string
  /**
   * Check descriptor, decryption, and UTF-8 validity without creating a JS credential string.
   * @param ciphertext - opaque CNG DPAPI ciphertext.
   * @returns whether it is `LOCAL=user` protected non-empty valid UTF-8.
   */
  probe(ciphertext: string): boolean
}

/**
 * Bind current-user protection behavior to one native operation table.
 * @param api - native operations, real in production and deterministic in failure-path tests.
 * @returns current-user protect, unprotect, and safe probe operations.
 */
export function createDpapiProtection(api: DpapiBindings): DpapiProtection {
  const decrypt = (ciphertext: string): Buffer => {
    const encrypted = Buffer.from(ciphertext, 'base64')
    try {
      return unprotectBuffer(api, encrypted)
    } finally {
      encrypted.fill(0)
    }
  }

  return {
    protect(value: string): string {
      const clear = Buffer.from(value, 'utf8')
      let encrypted: Buffer | undefined
      try {
        encrypted = protectBuffer(api, clear)
        return encrypted.toString('base64')
      } finally {
        clear.fill(0)
        encrypted?.fill(0)
      }
    },
    unprotect(ciphertext: string): string {
      const clear = decrypt(ciphertext)
      try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(clear)
        if (value.length === 0) throw new Error('credentials-windows-dpapi: decrypted credential is empty')
        return value
      } finally {
        clear.fill(0)
      }
    },
    probe(ciphertext: string): boolean {
      const clear = decrypt(ciphertext)
      try {
        return clear.length > 0 && isUtf8(clear)
      } finally {
        clear.fill(0)
      }
    },
  }
}

let cachedProtection: DpapiProtection | undefined

/** Resolve the singleton real Windows CNG DPAPI protection adapter. */
function protection(): DpapiProtection {
  cachedProtection ??= createDpapiProtection(bindings())
  return cachedProtection
}

/**
 * Encrypt one non-empty UTF-8 value with the CNG DPAPI `LOCAL=user` descriptor.
 * @param value - plaintext credential value.
 * @returns opaque current-user ciphertext.
 */
export function protectCurrentUser(value: string): string {
  return protection().protect(value)
}

/**
 * Decrypt one CNG DPAPI ciphertext only when its descriptor is exactly `LOCAL=user`.
 * @param ciphertext - opaque CNG DPAPI ciphertext.
 * @returns plaintext credential value.
 */
export function unprotectCurrentUser(ciphertext: string): string {
  return protection().unprotect(ciphertext)
}

/**
 * Check `LOCAL=user` scope and plaintext validity without creating a JS string.
 * @param ciphertext - opaque CNG DPAPI ciphertext.
 * @returns whether the record is available to this Windows user.
 */
export function probeCurrentUser(ciphertext: string): boolean {
  return protection().probe(ciphertext)
}
