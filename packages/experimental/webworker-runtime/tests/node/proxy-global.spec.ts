/** Proxy predicates preserve identity without invoking user traps in the worker graph. */
import { isProxy as nodeIsProxy } from 'node:util/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installProxyGlobal, isWorkerProxy } from '../../src/node/globals/proxy.ts'
import { types } from '../../src/node/builtin_modules/implemented/util.ts'
import { isProxy } from '../../src/node/builtin_modules/implemented/util/types.ts'

describe('worker Proxy identity', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function install(): void {
    vi.stubGlobal('Proxy', globalThis.Proxy)
    installProxyGlobal()
  }

  it('matches Node for object, array, function, and nested proxies without running traps', () => {
    install()
    const trap = vi.fn(() => { throw new Error('trap must not run') })
    const handler = new Proxy({}, { get: trap })
    const values = [
      new Proxy({}, handler),
      new Proxy([], handler),
      new Proxy(() => 1, handler),
      new Proxy(new Proxy({}, handler), handler),
      {}, [], () => 1, null, undefined, 0, 'text', Symbol('plain'),
    ]
    for (const value of values) expect(isProxy(value)).toBe(nodeIsProxy(value))
    expect(types.isProxy).toBe(isProxy)
    expect(trap).not.toHaveBeenCalled()
  })

  it('retains revoked identities through direct and descriptor-based revocable access', () => {
    install()
    const direct = Proxy.revocable({}, {})
    const descriptor = Object.getOwnPropertyDescriptor(Proxy, 'revocable')!
    const throughDescriptor = (descriptor.value as ProxyConstructor['revocable'])({}, {})
    for (const entry of [direct, throughDescriptor]) {
      expect(isProxy(entry.proxy)).toBe(true)
      entry.revoke()
      expect(isProxy(entry.proxy)).toBe(true)
      expect(nodeIsProxy(entry.proxy)).toBe(true)
    }
  })

  it('preserves construction, call rejection, and ordinary constructor metadata', () => {
    install()
    const proxy = new Proxy({ value: 1 }, { get: () => 2 })
    expect(proxy.value).toBe(2)
    expect(Proxy.name).toBe('Proxy')
    expect(Object.getOwnPropertyDescriptor(Proxy, 'length')?.value).toBe(2)
    expect(Object.getOwnPropertyDescriptor(Proxy, 'absent')).toBeUndefined()
    expect(() => { Reflect.apply(Proxy, undefined, [{}, {}]) }).toThrow(TypeError)
    expect(() => { Reflect.construct(Proxy, [null, {}]) }).toThrow(TypeError)
    expect(isWorkerProxy(Proxy)).toBe(false)
  })

  it('keeps installed identities across repeated installation and excludes pre-bootstrap objects', () => {
    const prior = new Proxy({}, {})
    install()
    const installed = Proxy
    const current = new Proxy({}, {})
    installProxyGlobal()
    expect(Proxy).toBe(installed)
    expect(isProxy(current)).toBe(true)
    expect(isProxy(prior)).toBe(false)
  })
})
