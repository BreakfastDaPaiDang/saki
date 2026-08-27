/** Per-identity control-plane operation serialization. @module @breakfastdapaidang/saki-control-plane/src/keyed-operation */

/**
 * Enqueue one operation behind the current tail for an aggregate identity.
 * @param tails - mutable aggregate tails owned by one service instance.
 * @param key - aggregate identity whose operations must remain ordered.
 * @param operation - work started after the preceding tail settles successfully or unsuccessfully.
 * @returns the operation result while retaining only a settlement-only queue tail.
 */
export function enqueueKeyedOperation<K, T>(
  tails: Map<K, Promise<void>>,
  key: K,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  const result = previous.then(operation)
  const tail = result.then(() => undefined, () => undefined)
  tails.set(key, tail)
  return result.finally(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
}
