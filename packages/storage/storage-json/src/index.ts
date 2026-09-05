/**
 * JSON storage backend: whole-unit files or per-record trees under a configured
 * root, published by atomic file rewrite. Registers on the storage hub
 * under its configured backend name.
 * @module @deepseek-ai/dsh-storage-json
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ClosedUnitReservations, StorageError, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { createClosedUnitOperations } from './closed.ts'
import { validateDescriptor } from './format.ts'
import { StorageRootGuard } from './medium.ts'
import { openSingleUnit } from './single-unit.ts'
import { openPerRecordUnit } from './per-record-unit.ts'

/** Cordis plugin name. */
export const name = 'storage-json'
/** The hub must exist before the backend can register. */
export const inject = ['storage']

/**
 * Plugin configuration.
 * `root` has NO default on purpose: a `process.cwd()` fallback would scatter
 * unit files wherever the process happens to start; assemblies state the
 * location explicitly.
 */
export interface Config {
  /** Storage registry name; defaults to `json`. */
  backend?: string
  /** Directory holding one `<unit>.json` file (or `<unit>/` tree) per unit. */
  root: string
}

/** Config schema. */
export const Config: z<Config> = z.object({
  backend: z.string().default('json'),
  root: z.string().required(),
})

/** JSON backend: resolves and owns one file-tree root and serves the `kv` facet. */
export class JsonStorageBackend implements StorageBackend {
  /** Key-value serving and optional closed-unit operations over this root. */
  readonly kv: KvFacet
  private readonly root: string
  private readonly rootGuard: StorageRootGuard
  private readonly open = new Map<string, KvUnit>()
  // Reserved synchronously at open() entry so a concurrent open of the same
  // unit fails, and close() can await opens still in flight.
  private readonly opening = new Map<string, Promise<KvUnit>>()
  /** Closed-unit reservations observed by backend close. */
  private readonly cold = new ClosedUnitReservations()
  private closed = false

  constructor(root: string) {
    this.root = resolve(root)
    this.rootGuard = new StorageRootGuard(this.root)
    this.kv = {
      closed: createClosedUnitOperations(this.root, (name) => {
        if (this.closed) {
          throw new StorageError('closed', 'json backend is closed')
        }
        if (this.open.has(name) || this.opening.has(name) || this.cold.has(name)) {
          throw new StorageError('unit-open', `json unit '${name}' has a live or opening handle`)
        }
        return this.cold.reserve(name)
      }, undefined, this.rootGuard),
      // The body up to the first await runs synchronously, so the opening-slot
      // reservation below still excludes a concurrent open of the same unit.
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        if (this.closed) throw new StorageError('closed', 'json backend is closed')
        validateDescriptor(descriptor)
        if (this.open.has(descriptor.name) || this.opening.has(descriptor.name)) {
          // Double-open is a caller bug, not a medium condition.
          throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
        }
        if (this.cold.has(descriptor.name)) {
          throw new StorageError(
            'unit-open',
            `json unit '${descriptor.name}' is reserved by a closed-unit operation`,
          )
        }
        const opening = this.openUnit(descriptor)
        this.opening.set(descriptor.name, opening)
        return opening.finally(() => this.opening.delete(descriptor.name))
      },
    }
  }

  private async openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    await this.rootGuard.ensureCurrent(descriptor.name)
    const onClose = () => this.open.delete(descriptor.name)
    const unit = descriptor.layout === 'per-record'
      ? await openPerRecordUnit(descriptor, this.root, onClose)
      : await openSingleUnit(descriptor, this.root, onClose, undefined, this.rootGuard)
    if (this.closed) {
      // The backend closed while this open was in flight: do not hand out a
      // live unit past close().
      await unit.close()
      throw new StorageError('closed', 'json backend is closed')
    }
    this.open.set(descriptor.name, unit)
    return unit
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
    }
    // close() marks each current unit closed before its first await, so the
    // backend and every live handle stop admitting work in the same turn.
    const unitClosures = [...this.open.values()].map(unit => unit.close())
    await Promise.allSettled([...this.opening.values()])
    await Promise.allSettled(this.cold.settlements())
    await Promise.allSettled(unitClosures)
  }
}

/**
 * Register one named JSON backend on the storage hub.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config) {
  const backend = new JsonStorageBackend(config.root)
  const backendName = (config as Required<Config>).backend
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register(backendName, backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey(backendName), backend)
}
