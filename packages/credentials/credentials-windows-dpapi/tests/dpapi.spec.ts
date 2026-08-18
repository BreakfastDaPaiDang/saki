import { describe, expect, it } from 'vitest'
import { createDpapiProtection } from '../src/dpapi.ts'
import type { DpapiBindings } from '../src/dpapi.ts'

interface FakeOptions {
  protectResult?: number
  unprotectResult?: number
  outputBytes?: Buffer
  outputLength?: number
  outputPointer?: bigint | null
  freeResult?: bigint | null
  lastError?: number
}

function fakeBindings(options: FakeOptions = {}): DpapiBindings {
  const fill = (output: { cbData: number; pbData: bigint | null }, result: number): number => {
    output.cbData = options.outputLength ?? options.outputBytes?.length ?? 4
    output.pbData = options.outputPointer === undefined ? 1n : options.outputPointer
    return result
  }
  return {
    protect: (_input, output) => fill(output, options.protectResult ?? 1),
    unprotect: (_input, output) => fill(output, options.unprotectResult ?? 1),
    localFree: () => options.freeResult ?? null,
    getLastError: () => options.lastError ?? 5,
    view: () => options.outputBytes ?? Buffer.from('test'),
  }
}

describe('the DPAPI operation adapter', () => {
  it('copies native results and clears both plaintext and ciphertext input buffers', () => {
    const protectedInputs: Buffer[] = []
    const unprotectedInputs: Buffer[] = []
    const api = fakeBindings({ outputBytes: Buffer.from('clear') })
    const observed: DpapiBindings = {
      ...api,
      protect: (input, output) => {
        protectedInputs.push(input.pbData)
        return api.protect(input, output)
      },
      unprotect: (input, output) => {
        unprotectedInputs.push(input.pbData)
        return api.unprotect(input, output)
      },
    }
    const protection = createDpapiProtection(observed)

    expect(protection.protect('secret')).toBe(Buffer.from('clear').toString('base64'))
    expect(protection.unprotect(Buffer.from('cipher').toString('base64'))).toBe('clear')
    expect(protection.probe(Buffer.from('cipher').toString('base64'))).toBe(true)
    expect(protectedInputs[0]).toEqual(Buffer.alloc('secret'.length))
    for (const input of unprotectedInputs) expect(input).toEqual(Buffer.alloc('cipher'.length))
  })

  it('reports native failures by operation and Win32 code without input data', () => {
    const secret = 'must-not-appear'
    const protection = createDpapiProtection(fakeBindings({ protectResult: 0, unprotectResult: 0, lastError: 13 }))

    expect(() => protection.protect(secret)).toThrow('CryptProtectData failed with Win32 error 13')
    expect(() => protection.unprotect(Buffer.from(secret).toString('base64')))
      .toThrow('CryptUnprotectData failed with Win32 error 13')
    for (const operation of [
      () => protection.protect(secret),
      () => protection.unprotect(Buffer.from(secret).toString('base64')),
    ]) {
      try {
        operation()
      } catch (error) {
        expect((error as Error).message).not.toContain(secret)
      }
    }
  })

  it('sanitizes an exception thrown by a native binding', () => {
    const secret = 'binding-must-not-echo-this-value'
    const api = fakeBindings()
    api.protect = () => { throw new Error(secret) }
    api.unprotect = () => { throw new Error(secret) }
    const protection = createDpapiProtection(api)

    for (const operation of [
      () => protection.protect(secret),
      () => protection.unprotect(Buffer.from(secret).toString('base64')),
    ]) {
      const failure = (() => {
        try {
          operation()
        } catch (error) {
          return error as Error
        }
        throw new Error('native operation unexpectedly succeeded')
      })()
      expect(failure.message).toMatch(/Crypt(?:Protect|Unprotect)Data invocation failed/)
      expect(JSON.stringify(failure)).not.toContain(secret)
      expect(failure.cause).toBeUndefined()
    }
  })

  it('rejects empty native result forms and a failed LocalFree', () => {
    expect(() => createDpapiProtection(fakeBindings({ outputPointer: null })).protect('value'))
      .toThrow(/returned an empty result/)
    expect(() => createDpapiProtection(fakeBindings({ outputLength: 0 })).protect('value'))
      .toThrow(/returned an empty result/)
    expect(() => createDpapiProtection(fakeBindings({ freeResult: 2n })).protect('value'))
      .toThrow(/LocalFree failed/)
  })

  it('rejects empty and invalid UTF-8 plaintext while a safe probe reports empty', () => {
    const empty = createDpapiProtection(fakeBindings({ outputBytes: Buffer.alloc(0), outputLength: 1 }))
    expect(empty.probe('YQ==')).toBe(false)
    expect(() => empty.unprotect('YQ==')).toThrow(/decrypted credential is empty/)

    const invalidUtf8 = createDpapiProtection(fakeBindings({ outputBytes: Buffer.from([0xFF]) }))
    expect(invalidUtf8.probe('YQ==')).toBe(false)
    expect(() => invalidUtf8.unprotect('YQ==')).toThrow(TypeError)
  })
})
