/**
 * One opened JSON unit in `single` layout: the whole unit is one document at
 * `<root>/<name>.json`. The in-memory state is authoritative; every write
 * primitive mutates it and republishes the whole file atomically. Writes are
 * NOT queued here — per the backend contract, write ordering belongs to the
 * caller (the domain layer's write chain); this unit only guarantees that
 * each single call publishes a complete, durable file. The `per-record`
 * layout is a separate unit class in `per-record-unit.ts`.
 * @module @deepseek-ai/dsh-storage-json/src/single-unit
 */

import { dirname, join } from 'node:path'
import {
  cloneLosslessJsonValue,
  isCommitOutcomeUnknownStorageError,
  isPublishedStorageError,
  StorageError,
} from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { writeAtomic } from './atomic.ts'
import type { AtomicPublicationGuard } from './atomic.ts'
import { parse, serialize } from './format.ts'
import type { UnitState } from './format.ts'
import { readUnitFile } from './medium.ts'
import type { StorageRootGuard } from './medium.ts'

type PublishJsonFile = (
  path: string,
  data: string,
  guard?: AtomicPublicationGuard,
) => Promise<void>

/**
 * Open (load or lazily create) one `single`-layout unit under `root`: the
 * unit file is `<root>/<name>.json`.
 * @param descriptor - Static identity and shape of the unit.
 * @param root - Absolute backend root directory.
 * @param onClose - Backend callback releasing the unit's open-slot.
 * @param publishFile - Atomic publisher; overridden only by package tests.
 * @param rootGuard - Backend-owned persistent root identity guard.
 * @returns the opened unit.
 */
export async function openSingleUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
  publishFile: PublishJsonFile = writeAtomic,
  rootGuard?: StorageRootGuard,
): Promise<KvUnit> {
  const path = join(root, `${descriptor.name}.json`)
  await rootGuard?.observeCurrent(descriptor.name)
  const text = await readUnitFile(dirname(path), descriptor.name)
  await rootGuard?.observeCurrent(descriptor.name)
  const state: UnitState =
    text === undefined
      ? {
        global: null,
        tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
      }
      : parse(text, descriptor)
  return new SingleJsonUnit(descriptor, path, state, onClose, publishFile, rootGuard)
}

class SingleJsonUnit implements KvUnit {
  private closed = false
  /** In-flight reads and publishes; close() drains them before releasing the unit. */
  private readonly inFlight = new Set<Promise<unknown>>()
  /** The first write whose publication evidence requires backend recovery. */
  private uncertainWrite?: Error

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly path: string,
    private readonly state: UnitState,
    private readonly onClose: () => void,
    private readonly publishFile: PublishJsonFile,
    private readonly rootGuard?: StorageRootGuard,
  ) {}

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    return await this.track(this.loadSnapshot())
  }

  private async loadSnapshot(): Promise<{
    tables: Record<string, Record<string, unknown>>
    global: unknown
  }> {
    await this.rootGuard?.observeCurrent(this.descriptor.name)
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of this.state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    const snapshot = cloneLosslessJsonValue(
      { tables, global: this.state.global },
      `unit '${this.descriptor.name}' loaded snapshot`,
    )
    await this.rootGuard?.observeCurrent(this.descriptor.name)
    return snapshot
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    const hadKey = records.has(key)
    const previous = records.get(key)
    const admitted = cloneLosslessJsonValue(
      value,
      `unit '${this.descriptor.name}' table '${table}' key '${key}'`,
    )
    records.set(key, admitted)
    // Roll back on a failed publish: memory is authoritative, so a rejected
    // write must not survive in memory (or ride along with the next publish).
    await this.publish().catch((error: unknown) => {
      if (isPublishedStorageError(error) || isCommitOutcomeUnknownStorageError(error)) {
        this.uncertainWrite ??= error
      } else {
        if (hadKey) records.set(key, previous)
        else records.delete(key)
      }
      throw error
    })
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    if (!records.has(key)) return
    const previous = records.get(key)
    records.delete(key)
    await this.publish().catch((error: unknown) => {
      if (isPublishedStorageError(error) || isCommitOutcomeUnknownStorageError(error)) {
        this.uncertainWrite ??= error
      } else {
        records.set(key, previous)
      }
      throw error
    })
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    const previous = this.state.global
    this.state.global = cloneLosslessJsonValue(
      value,
      `unit '${this.descriptor.name}' global slot`,
    )
    await this.publish().catch((error: unknown) => {
      if (isPublishedStorageError(error) || isCommitOutcomeUnknownStorageError(error)) {
        this.uncertainWrite ??= error
      } else {
        this.state.global = previous
      }
      throw error
    })
  }

  /* jscpd:ignore-start -- the two unit classes are standalone; the drain/guard lifecycle mirrors the shared KvUnit contract */
  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.inFlight)
      return
    }
    this.closed = true
    await Promise.allSettled(this.inFlight)
    this.onClose()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
    if (this.uncertainWrite !== undefined) {
      throw new StorageError(
        'commit-outcome-unknown',
        `unit '${this.descriptor.name}' cannot continue after an uncertain write; close it and recreate the affected backend before reopening`,
        { cause: this.uncertainWrite },
      )
    }
  }
  /* jscpd:ignore-end */

  private records(table: string): Map<string, unknown> {
    const records = this.state.tables.get(table)
    if (!records) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return records
  }

  private async publish(): Promise<void> {
    const data = serialize(this.descriptor, this.state)
    await this.track(this.publishGuarded(data))
  }

  private async publishGuarded(data: string): Promise<void> {
    const guard = this.publicationGuard()
    await guard?.verify()
    await this.publishFile(this.path, data, guard)
  }

  private publicationGuard(): AtomicPublicationGuard | undefined {
    const rootGuard = this.rootGuard
    if (rootGuard === undefined) return undefined
    return { verify: () => rootGuard.observeCurrent(this.descriptor.name) }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation)
    // The caller receives the original promise. This observer only releases
    // lifecycle tracking and handles both outcomes so it cannot reject.
    void operation.then(
      () => { this.inFlight.delete(operation) },
      () => { this.inFlight.delete(operation) },
    )
    return operation
  }
}
