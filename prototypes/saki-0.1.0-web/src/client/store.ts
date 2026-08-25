import { useSyncExternalStore } from 'react'

/**
 * Minimal immutable-snapshot store, mirroring the DSH client discipline:
 * bare getSnapshot/subscribe sources bound to React via useSyncExternalStore.
 */
export interface SnapshotStore<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
  set: (next: T) => void
  update: (mutate: (current: T) => T) => void
}

export function createStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      if (Object.is(snapshot, next)) return
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    update: (mutate) => {
      const next = mutate(snapshot)
      if (!Object.is(snapshot, next)) {
        snapshot = next
        for (const listener of [...listeners]) listener()
      }
    },
  }
}

export function useStore<T>(store: SnapshotStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
