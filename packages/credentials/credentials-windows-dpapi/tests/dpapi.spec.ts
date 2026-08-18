import { describe, expect, it } from 'vitest'
import { createDpapiProtection } from '../src/dpapi.ts'
import type { DpapiBindings } from '../src/dpapi.ts'

interface FakeOptions {
  createStatus?: number
  protectStatus?: number
  unprotectStatus?: number
  ruleStatus?: number
  closeStatus?: number
  outputBytes?: Buffer
  outputLength?: number
  outputPointer?: bigint | null
  descriptorHandle?: bigint | null
  descriptorRule?: string | null
  freeResult?: bigint | null
  rulePointer?: bigint | null
  throwAt?: 'create' | 'protect' | 'unprotect' | 'rule' | 'decode-rule' | 'close' | 'zero' | 'free' | 'view'
}

interface FakeDpapi {
  api: DpapiBindings
  events: string[]
  protectedInputs: Buffer[]
  unprotectedInputs: Buffer[]
}

function fakeBindings(options: FakeOptions = {}): FakeDpapi {
  const events: string[] = []
  const protectedInputs: Buffer[] = []
  const unprotectedInputs: Buffer[] = []
  const fail = (operation: NonNullable<FakeOptions['throwAt']>): void => {
    if (options.throwAt === operation) throw new Error('binding-must-not-escape')
  }
  const fill = (output: { pointer: bigint | null; length: number }): void => {
    output.length = options.outputLength ?? options.outputBytes?.length ?? 4
    output.pointer = options.outputPointer === undefined ? 1n : options.outputPointer
  }
  const api: DpapiBindings = {
    createDescriptor: (rule, output) => {
      events.push(`create:${rule}`)
      output.handle = options.descriptorHandle === undefined ? 2n : options.descriptorHandle
      fail('create')
      return options.createStatus ?? 0
    },
    protect: (_descriptor, input, output) => {
      events.push('protect')
      protectedInputs.push(input)
      fill(output)
      fail('protect')
      return options.protectStatus ?? 0
    },
    unprotect: (input, descriptor, output) => {
      events.push('unprotect')
      unprotectedInputs.push(input)
      descriptor.handle = options.descriptorHandle === undefined ? 2n : options.descriptorHandle
      fill(output)
      fail('unprotect')
      return options.unprotectStatus ?? 0
    },
    getDescriptorRule: (_descriptor, output) => {
      events.push('rule')
      output.pointer = options.rulePointer === undefined ? 3n : options.rulePointer
      fail('rule')
      return options.ruleStatus ?? 0
    },
    decodeDescriptorRule: () => {
      events.push('decode-rule')
      fail('decode-rule')
      return options.descriptorRule ?? 'LOCAL=user'
    },
    closeDescriptor: () => {
      events.push('close')
      fail('close')
      return options.closeStatus ?? 0
    },
    secureZeroMemory: (pointer, length) => {
      events.push(`zero:${String(pointer)}:${String(length)}`)
      fail('zero')
    },
    localFree: (pointer) => {
      events.push(`free:${String(pointer)}`)
      fail('free')
      return options.freeResult ?? null
    },
    view: () => {
      events.push('view')
      fail('view')
      return options.outputBytes ?? Buffer.from('test')
    },
  }
  return { api, events, protectedInputs, unprotectedInputs }
}

describe('the CNG DPAPI operation adapter', () => {
  it('verifies LOCAL=user, copies native results, and wipes before every free', () => {
    const fake = fakeBindings({ outputBytes: Buffer.from('clear') })
    const protection = createDpapiProtection(fake.api)

    expect(protection.protect('secret')).toBe(Buffer.from('clear').toString('base64'))
    expect(protection.unprotect(Buffer.from('cipher').toString('base64'))).toBe('clear')
    expect(protection.probe(Buffer.from('cipher').toString('base64'))).toBe(true)
    expect(fake.protectedInputs[0]).toEqual(Buffer.alloc('secret'.length))
    for (const input of fake.unprotectedInputs) expect(input).toEqual(Buffer.alloc('cipher'.length))
    expect(fake.events).toEqual([
      'create:LOCAL=user', 'protect', 'view', 'zero:1:5', 'free:1', 'close',
      'unprotect', 'rule', 'decode-rule', 'free:3', 'view', 'zero:1:5', 'free:1', 'close',
      'unprotect', 'rule', 'decode-rule', 'free:3', 'view', 'zero:1:5', 'free:1', 'close',
    ])
  })

  it('rejects LOCAL=machine before copying and wipes the returned plaintext allocation', () => {
    const fake = fakeBindings({ descriptorRule: 'LOCAL=machine', outputBytes: Buffer.from('clear') })

    expect(() => createDpapiProtection(fake.api).unprotect('YQ=='))
      .toThrow(/not scoped to the current Windows user/)
    expect(fake.events).toEqual([
      'unprotect', 'rule', 'decode-rule', 'free:3', 'zero:1:5', 'free:1', 'close',
    ])
  })

  it('rejects a missing or unreadable protection descriptor before copying plaintext', () => {
    const missing = fakeBindings({ descriptorHandle: null })
    expect(() => createDpapiProtection(missing.api).unprotect('YQ==')).toThrow(/returned no descriptor/)
    expect(missing.events).toEqual(['unprotect', 'zero:1:4', 'free:1'])

    const missingRule = fakeBindings({ rulePointer: null })
    expect(() => createDpapiProtection(missingRule.api).unprotect('YQ==')).toThrow(/returned no rule/)
    expect(missingRule.events).toEqual(['unprotect', 'rule', 'zero:1:4', 'free:1', 'close'])

    const failedRule = fakeBindings({ ruleStatus: 13 })
    expect(() => createDpapiProtection(failedRule.api).unprotect('YQ=='))
      .toThrow(/NCryptGetProtectionDescriptorInfo failed with status 13/)
    expect(failedRule.events).toEqual(['unprotect', 'rule', 'free:3', 'zero:1:4', 'free:1', 'close'])

    const failedMissingRule = fakeBindings({ ruleStatus: 13, rulePointer: null })
    expect(() => createDpapiProtection(failedMissingRule.api).unprotect('YQ=='))
      .toThrow(/NCryptGetProtectionDescriptorInfo failed with status 13/)

    const zeroRule = fakeBindings({ rulePointer: 0n })
    expect(() => createDpapiProtection(zeroRule.api).unprotect('YQ==')).toThrow(/returned no rule/)
  })

  it('releases outputs and descriptor handles returned alongside native failure statuses', () => {
    const protect = fakeBindings({ protectStatus: -1 })
    expect(() => createDpapiProtection(protect.api).protect('secret'))
      .toThrow(/NCryptProtectSecret failed with status 4294967295/)
    expect(protect.events).toEqual(['create:LOCAL=user', 'protect', 'zero:1:4', 'free:1', 'close'])

    const unprotect = fakeBindings({ unprotectStatus: 5 })
    expect(() => createDpapiProtection(unprotect.api).unprotect('YQ=='))
      .toThrow(/NCryptUnprotectSecret failed with status 5/)
    expect(unprotect.events).toEqual(['unprotect', 'zero:1:4', 'free:1', 'close'])
  })

  it('sanitizes exceptions thrown by native operations', () => {
    for (const [throwAt, invoke, message, events] of [
      [
        'create',
        (api: DpapiBindings) => createDpapiProtection(api).protect('secret'),
        'NCryptCreateProtectionDescriptor',
        ['create:LOCAL=user', 'close'],
      ],
      [
        'protect',
        (api: DpapiBindings) => createDpapiProtection(api).protect('secret'),
        'NCryptProtectSecret',
        ['create:LOCAL=user', 'protect', 'zero:1:4', 'free:1', 'close'],
      ],
      [
        'unprotect',
        (api: DpapiBindings) => createDpapiProtection(api).unprotect('YQ=='),
        'NCryptUnprotectSecret',
        ['unprotect', 'zero:1:4', 'free:1', 'close'],
      ],
      [
        'rule',
        (api: DpapiBindings) => createDpapiProtection(api).unprotect('YQ=='),
        'NCryptGetProtectionDescriptorInfo',
        ['unprotect', 'rule', 'free:3', 'zero:1:4', 'free:1', 'close'],
      ],
      [
        'decode-rule',
        (api: DpapiBindings) => createDpapiProtection(api).unprotect('YQ=='),
        'cannot decode the protection descriptor',
        ['unprotect', 'rule', 'decode-rule', 'free:3', 'zero:1:4', 'free:1', 'close'],
      ],
    ] as const) {
      const fake = fakeBindings({ throwAt })
      const expected = throwAt === 'decode-rule' ? message : `${message} invocation failed`
      expect(() => invoke(fake.api)).toThrow(new Error(`credentials-windows-dpapi: ${expected}`))
      expect(fake.events).toEqual(events)
    }

    const createWithoutHandle = fakeBindings({ throwAt: 'create', descriptorHandle: null })
    expect(() => createDpapiProtection(createWithoutHandle.api).protect('secret'))
      .toThrow(/NCryptCreateProtectionDescriptor invocation failed/)
    expect(createWithoutHandle.events).toEqual(['create:LOCAL=user'])

    const unprotectWithoutHandle = fakeBindings({ throwAt: 'unprotect', descriptorHandle: null })
    expect(() => createDpapiProtection(unprotectWithoutHandle.api).unprotect('YQ=='))
      .toThrow(/NCryptUnprotectSecret invocation failed/)
    expect(unprotectWithoutHandle.events).toEqual(['unprotect', 'zero:1:4', 'free:1'])
  })

  it('releases descriptor rule strings on success and every inspection failure', () => {
    const failedFree = fakeBindings({ outputPointer: null })
    failedFree.api.localFree = (pointer) => {
      failedFree.events.push(`free:${String(pointer)}`)
      if (pointer === 3n) {
        return 3n
      }
      return null
    }
    expect(() => createDpapiProtection(failedFree.api).unprotect('YQ=='))
      .toThrow(/LocalFree failed after descriptor inspection/)
    expect(failedFree.events).toEqual(['unprotect', 'rule', 'decode-rule', 'free:3', 'close'])

    const thrownFree = fakeBindings({ outputPointer: null })
    thrownFree.api.localFree = (pointer) => {
      thrownFree.events.push(`free:${String(pointer)}`)
      if (pointer === 3n) {
        throw new Error('binding-must-not-escape')
      }
      return null
    }
    expect(() => createDpapiProtection(thrownFree.api).unprotect('YQ=='))
      .toThrow(/LocalFree invocation failed after descriptor inspection/)
    expect(thrownFree.events).toEqual(['unprotect', 'rule', 'decode-rule', 'free:3', 'close'])
  })

  it('closes handles returned with descriptor errors and sanitizes close failures', () => {
    const failedCreate = fakeBindings({ createStatus: 5 })
    expect(() => createDpapiProtection(failedCreate.api).protect('secret'))
      .toThrow(/NCryptCreateProtectionDescriptor failed with status 5/)
    expect(failedCreate.events).toEqual(['create:LOCAL=user', 'close'])

    const missingCreate = fakeBindings({ createStatus: 5, descriptorHandle: null })
    expect(() => createDpapiProtection(missingCreate.api).protect('secret'))
      .toThrow(/NCryptCreateProtectionDescriptor failed with status 5/)
    expect(missingCreate.events).toEqual(['create:LOCAL=user'])

    const missingHandle = fakeBindings({ descriptorHandle: null })
    expect(() => createDpapiProtection(missingHandle.api).protect('secret')).toThrow(/returned no handle/)

    const failedClose = fakeBindings({ closeStatus: 9 })
    expect(() => createDpapiProtection(failedClose.api).unprotect('YQ=='))
      .toThrow(/NCryptCloseProtectionDescriptor failed after NCryptUnprotectSecret with status 9/)
    expect(failedClose.events).toEqual([
      'unprotect', 'rule', 'decode-rule', 'free:3', 'view', 'zero:1:4', 'free:1', 'close',
    ])

    const thrownClose = fakeBindings({ throwAt: 'close' })
    expect(() => createDpapiProtection(thrownClose.api).protect('secret'))
      .toThrow(/NCryptCloseProtectionDescriptor invocation failed/)
    expect(thrownClose.events).toEqual(['create:LOCAL=user', 'protect', 'view', 'zero:1:4', 'free:1', 'close'])
  })

  it('wipes and frees a non-null zero-length allocation before rejecting it', () => {
    const fake = fakeBindings({ outputLength: 0 })

    expect(() => createDpapiProtection(fake.api).protect('value')).toThrow(/returned an empty result/)
    expect(fake.events).toEqual(['create:LOCAL=user', 'protect', 'zero:1:0', 'free:1', 'close'])
  })

  it('rejects null outputs and reports cleanup failures without retaining copied bytes', () => {
    const empty = fakeBindings({ outputPointer: null })
    expect(() => createDpapiProtection(empty.api).protect('value')).toThrow(/returned an empty result/)
    expect(empty.events).toEqual(['create:LOCAL=user', 'protect', 'close'])

    const zeroPointer = fakeBindings({ outputPointer: 0n })
    expect(() => createDpapiProtection(zeroPointer.api).protect('value')).toThrow(/returned an empty result/)

    const freeFailure = fakeBindings({ freeResult: 2n })
    expect(() => createDpapiProtection(freeFailure.api).protect('value')).toThrow(/LocalFree failed/)

    const thrownFree = fakeBindings({ throwAt: 'free' })
    expect(() => createDpapiProtection(thrownFree.api).protect('value'))
      .toThrow(/LocalFree invocation failed/)
    expect(thrownFree.events).toEqual(['create:LOCAL=user', 'protect', 'view', 'zero:1:4', 'free:1', 'close'])

    const zeroFailure = fakeBindings({ throwAt: 'zero' })
    expect(() => createDpapiProtection(zeroFailure.api).protect('value')).toThrow(/zeroization failed/)
    expect(zeroFailure.events).toEqual(['create:LOCAL=user', 'protect', 'view', 'zero:1:4', 'free:1', 'close'])

    const viewFailure = fakeBindings({ throwAt: 'view' })
    expect(() => createDpapiProtection(viewFailure.api).protect('value')).toThrow(/cannot copy/)
    expect(viewFailure.events).toEqual(['create:LOCAL=user', 'protect', 'view', 'zero:1:4', 'free:1', 'close'])
  })

  it('rejects empty and invalid UTF-8 plaintext while a safe probe reports invalid', () => {
    const empty = createDpapiProtection(fakeBindings({ outputBytes: Buffer.alloc(0), outputLength: 1 }).api)
    expect(empty.probe('YQ==')).toBe(false)
    expect(() => empty.unprotect('YQ==')).toThrow(/decrypted credential is empty/)

    const invalidUtf8 = createDpapiProtection(fakeBindings({ outputBytes: Buffer.from([0xFF]) }).api)
    expect(invalidUtf8.probe('YQ==')).toBe(false)
    expect(() => invalidUtf8.unprotect('YQ==')).toThrow(TypeError)
  })
})
