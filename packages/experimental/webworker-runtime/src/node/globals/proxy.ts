/** Proxy identity tracking for modules evaluated inside the dedicated worker. */

const NativeProxy = globalThis.Proxy
const nativeRevocable = NativeProxy.revocable
const proxies = new WeakSet<object>()

const revocable: ProxyConstructor['revocable'] = (target, handler) => {
  const result = nativeRevocable(target, handler)
  proxies.add(result.proxy)
  return result
}

const WorkerProxy = new NativeProxy(NativeProxy, {
  construct(target, argumentsList, newTarget) {
    // Native Proxy construction either throws or returns an object, including callable proxies.
    const proxy = Reflect.construct(target, argumentsList, newTarget) as object
    proxies.add(proxy)
    return proxy
  },
  get(target, property, receiver): unknown {
    return property === 'revocable' ? revocable : Reflect.get(target, property, receiver)
  },
  getOwnPropertyDescriptor(target, property) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
    return property === 'revocable' ? { ...descriptor, value: revocable } : descriptor
  },
})

/** Install before evaluating the VFS module graph; incoming worker messages cannot carry proxies. */
export function installProxyGlobal(): void {
  globalThis.Proxy = WorkerProxy
}

/**
 * Identify a proxy created through the worker's installed constructor, including revoked proxies.
 * Objects from before installation or another realm are outside this predicate's scope.
 * @param value - Candidate value, inspected only by identity.
 * @returns Whether the worker constructor created the value.
 */
export function isWorkerProxy(value: unknown): boolean {
  return (typeof value === 'object' && value !== null || typeof value === 'function') && proxies.has(value)
}
