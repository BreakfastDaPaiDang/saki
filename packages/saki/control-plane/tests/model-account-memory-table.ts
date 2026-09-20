import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

export class MemoryTable<K extends string, V> implements KvTable<K, V> {
  readonly records = new Map<K, V>()
  get size(): number { return this.records.size }
  get(key: K): V | undefined { return this.records.get(key) }
  entries(): IterableIterator<[K, V]> { return new Map(this.records).entries() }
  keys(): IterableIterator<K> { return new Map(this.records).keys() }
  async put(key: K, value: V): Promise<void> { this.records.set(key, structuredClone(value)) }
  async delete(key: K): Promise<boolean> { return this.records.delete(key) }
  async update(key: K, update: (current: V) => V): Promise<V> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error('missing record')
    const next = update(current)
    await this.put(key, next)
    return next
  }
}
