/**
 * Minimal Win32 DPAPI adapter for current-user credential protection.
 * `CRYPTPROTECT_UI_FORBIDDEN` is the only flag: omitting
 * `CRYPTPROTECT_LOCAL_MACHINE` is what selects current-user scope. Optional
 * entropy and the description are both null so the document has no second
 * portable secret and decryption never prompts.
 * @module @deepseek-ai/dsh-credentials-windows-dpapi/dpapi
 */

import koffi from 'koffi'
import { isUtf8 } from 'node:buffer'

const CRYPTPROTECT_UI_FORBIDDEN = 0x1

type NativePtr = bigint
type Ptr = ReturnType<typeof koffi.pointer>

interface BlobOutput {
  cbData: number
  pbData: NativePtr | null
}

/** Native operations used by the DPAPI adapter; separated for fail-path verification. */
export interface DpapiBindings {
  /**
   * Invoke current-user CryptProtectData.
   * @param input - non-empty bytes to protect.
   * @param output - structure populated with the DPAPI-owned result.
   * @returns nonzero on success.
   */
  protect(input: { cbData: number; pbData: Buffer }, output: BlobOutput): number
  /**
   * Invoke current-user CryptUnprotectData.
   * @param input - opaque ciphertext bytes to decrypt.
   * @param output - structure populated with the DPAPI-owned result.
   * @returns nonzero on success.
   */
  unprotect(input: { cbData: number; pbData: Buffer }, output: BlobOutput): number
  /**
   * Release one DPAPI-owned output allocation.
   * @param pointer - allocation returned by a DPAPI operation.
   * @returns null on success, or the unreleased pointer on failure.
   */
  localFree(pointer: NativePtr): NativePtr | null
  /**
   * Read the calling thread's last Win32 error.
   * @returns Win32 error number.
   */
  getLastError(): number
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
const DATA_BLOB = koffi.struct('DSH_CREDENTIAL_DATA_BLOB', {
  cbData: 'uint32',
  pbData: PBYTE,
})

/** Load the Win32 functions only when a credential operation actually needs them. */
function bindings(): DpapiBindings {
  /* v8 ignore next 2 -- Linux executes the non-Windows rejection peer; native Windows coverage executes the bindings. */
  if (process.platform !== 'win32') {
    throw new Error('credentials-windows-dpapi requires Windows')
  }
  const crypt32 = koffi.load('crypt32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const protect = crypt32.func('__stdcall', 'CryptProtectData', 'int', [
    koffi.pointer(DATA_BLOB), 'str16', koffi.pointer(DATA_BLOB), PVOID, PVOID, 'uint32', koffi.out(koffi.pointer(DATA_BLOB)),
  ]) as unknown as (
    input: { cbData: number; pbData: Buffer }, description: null, entropy: null,
    reserved: null, prompt: null, flags: number, output: BlobOutput,
  ) => number
  const unprotect = crypt32.func('__stdcall', 'CryptUnprotectData', 'int', [
    koffi.pointer(DATA_BLOB), PVOID, koffi.pointer(DATA_BLOB), PVOID, PVOID, 'uint32', koffi.out(koffi.pointer(DATA_BLOB)),
  ]) as unknown as (
    input: { cbData: number; pbData: Buffer }, description: null, entropy: null,
    reserved: null, prompt: null, flags: number, output: BlobOutput,
  ) => number
  const localFree = kernel32.func('__stdcall', 'LocalFree', PVOID, [PVOID]) as unknown as
    (pointer: NativePtr) => NativePtr | null
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []) as unknown as () => number
  return {
    protect: (input, output) => protect(input, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, output),
    unprotect: (input, output) => unprotect(input, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, output),
    localFree,
    getLastError,
    view: (pointer, length) => new Uint8Array(koffi.view(pointer, length)),
  }
}

/** Copy one DPAPI-owned output allocation and release it with LocalFree. */
function takeOutput(api: DpapiBindings, operation: string, output: BlobOutput): Buffer {
  const pointer = output.pbData
  if (pointer === null || pointer === 0n || output.cbData === 0) {
    throw new Error(`credentials-windows-dpapi: ${operation} returned an empty result`)
  }
  let result: Buffer | undefined
  try {
    result = Buffer.from(api.view(pointer, output.cbData))
  } finally {
    const notFreed = api.localFree(pointer)
    if (notFreed !== null && notFreed !== 0n) {
      result?.fill(0)
      throw new Error(`credentials-windows-dpapi: LocalFree failed after ${operation}`)
    }
  }
  return result
}

/** Invoke one DPAPI operation without allowing native diagnostics to quote input bytes. */
function transform(api: DpapiBindings, operation: 'CryptProtectData' | 'CryptUnprotectData', input: Buffer): Buffer {
  const output: BlobOutput = { cbData: 0, pbData: null }
  let succeeded: number
  try {
    succeeded = operation === 'CryptProtectData'
      ? api.protect({ cbData: input.length, pbData: input }, output)
      : api.unprotect({ cbData: input.length, pbData: input }, output)
  } catch {
    throw new Error(`credentials-windows-dpapi: ${operation} invocation failed`)
  }
  if (succeeded === 0) {
    const code = api.getLastError()
    throw new Error(`credentials-windows-dpapi: ${operation} failed with Win32 error ${String(code)}`)
  }
  return takeOutput(api, operation, output)
}

/** Current-user protection operations used by the file Provider. */
export interface DpapiProtection {
  /**
   * Encrypt one non-empty UTF-8 value to canonical base64.
   * @param value - plaintext credential value.
   * @returns opaque current-user DPAPI ciphertext.
   */
  protect(value: string): string
  /**
   * Decrypt one canonical base64 ciphertext to a non-empty UTF-8 value.
   * @param ciphertext - opaque current-user DPAPI ciphertext.
   * @returns plaintext credential value.
   */
  unprotect(ciphertext: string): string
  /**
   * Check decryption and UTF-8 validity without creating a JS credential string.
   * @param ciphertext - opaque current-user DPAPI ciphertext.
   * @returns whether it decrypts to a non-empty valid UTF-8 value.
   */
  probe(ciphertext: string): boolean
}

/**
 * Bind current-user protection behavior to one native operation table.
 * @param api - native operations, real in production and deterministic in failure-path tests.
 * @returns current-user protect, unprotect, and safe probe operations.
 */
export function createDpapiProtection(api: DpapiBindings): DpapiProtection {
  const unprotectBuffer = (ciphertext: string): Buffer => {
    const encrypted = Buffer.from(ciphertext, 'base64')
    try {
      return transform(api, 'CryptUnprotectData', encrypted)
    } finally {
      encrypted.fill(0)
    }
  }

  return {
    protect(value: string): string {
      const clear = Buffer.from(value, 'utf8')
      let encrypted: Buffer | undefined
      try {
        encrypted = transform(api, 'CryptProtectData', clear)
        return encrypted.toString('base64')
      } finally {
        clear.fill(0)
        encrypted?.fill(0)
      }
    },
    unprotect(ciphertext: string): string {
      const clear = unprotectBuffer(ciphertext)
      try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(clear)
        if (value.length === 0) throw new Error('credentials-windows-dpapi: decrypted credential is empty')
        return value
      } finally {
        clear.fill(0)
      }
    },
    probe(ciphertext: string): boolean {
      const clear = unprotectBuffer(ciphertext)
      try {
        return clear.length > 0 && isUtf8(clear)
      } finally {
        clear.fill(0)
      }
    },
  }
}

let cachedProtection: DpapiProtection | undefined

/** Resolve the singleton real Win32 protection adapter. */
function protection(): DpapiProtection {
  cachedProtection ??= createDpapiProtection(bindings())
  return cachedProtection
}

/**
 * Encrypt one non-empty UTF-8 value with DPAPI current-user scope.
 * @param value - plaintext credential value.
 * @returns opaque current-user DPAPI ciphertext.
 */
export function protectCurrentUser(value: string): string {
  return protection().protect(value)
}

/**
 * Decrypt one DPAPI current-user ciphertext.
 * @param ciphertext - opaque current-user DPAPI ciphertext.
 * @returns plaintext credential value.
 */
export function unprotectCurrentUser(ciphertext: string): string {
  return protection().unprotect(ciphertext)
}

/**
 * Check current-user decryption without creating a JS credential string.
 * @param ciphertext - opaque current-user DPAPI ciphertext.
 * @returns whether it decrypts to a non-empty valid UTF-8 value.
 */
export function probeCurrentUser(ciphertext: string): boolean {
  return protection().probe(ciphertext)
}
