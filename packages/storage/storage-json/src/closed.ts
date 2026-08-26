/** Closed-unit operations for the JSON backend. @module @deepseek-ai/dsh-storage-json/src/closed */

import { join } from 'node:path'
import {
  assertLosslessJsonValue,
  isCommitOutcomeUnknownStorageError,
  StorageError,
} from '@deepseek-ai/dsh-storage'
import type {
  KvClosedUnitInspection,
  KvClosedUnitLease,
  KvClosedUnitMaterialization,
  KvClosedUnitOperations,
  KvUnitDescriptor,
  KvUnitSnapshot,
} from '@deepseek-ai/dsh-storage'
import { writeAtomicCreate } from './atomic.ts'
import type { AtomicPublicationGuard } from './atomic.ts'
import {
  parseStoredJsonUnit,
  serialize,
  snapshotOf,
  validateDescriptor,
  validateStoredDescriptor,
  validateUnitName,
} from './format.ts'
import type { StoredJsonUnit, UnitState } from './format.ts'
import { readUnitFile, StorageRootGuard } from './medium.ts'

/** Reserve one name against live or concurrent cold access until disposal. */
type ReserveClosedUnit = (name: string) => () => void
type PublishMissingJsonFile = typeof writeAtomicCreate

/**
 * Build the optional closed-unit operation group over one JSON storage root.
 * @param root - Directory containing unit JSON files.
 * @param reserveClosedUnit - Backend-owned exclusive unit-name reservation.
 * @param publishMissing - Create-only publisher; overridden only by package tests.
 * @param rootGuard - Backend-owned persistent root identity guard.
 * @returns the closed-unit operations.
 */
export function createClosedUnitOperations(
  root: string,
  reserveClosedUnit: ReserveClosedUnit,
  publishMissing: PublishMissingJsonFile = writeAtomicCreate,
  rootGuard: StorageRootGuard = new StorageRootGuard(root),
): KvClosedUnitOperations {
  return {
    withReservedUnit: <T>(
      name: string,
      signal: AbortSignal,
      operation: (lease: KvClosedUnitLease) => Promise<T>,
    ): Promise<T> => {
      let release: (() => void) | undefined
      try {
        signal.throwIfAborted()
        release = reserveClosedUnit(name)
        validateUnitName(name)
      } catch (error) {
        release?.()
        return Promise.reject(error instanceof Error
          ? error
          : new Error('json closed-unit reservation failed', { cause: error }))
      }
      const lease = new JsonClosedUnitLease(root, name, signal, publishMissing, rootGuard)
      return (async () => {
        try {
          return await operation(lease)
        } finally {
          lease.expire()
          await lease.drain()
          release()
        }
      })()
    },
  }
}

class JsonClosedUnitLease implements KvClosedUnitLease {
  private active = true
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(
    private readonly root: string,
    readonly name: string,
    private readonly signal: AbortSignal,
    private readonly publishMissing: PublishMissingJsonFile,
    private readonly rootGuard: StorageRootGuard,
  ) {}

  inspect(): Promise<KvClosedUnitInspection | undefined> {
    return this.admit(() => this.inspectAdmitted())
  }

  private async inspectAdmitted(): Promise<KvClosedUnitInspection | undefined> {
    this.assertPreCommit()
    await this.rootGuard.observeCurrent(this.name)
    const stored = await readStoredUnit(this.root, this.name, this.signal)
    await this.rootGuard.observeCurrent(this.name)
    this.assertPreCommit()
    return stored === undefined ? undefined : inspectionOf(stored)
  }

  read(descriptor: KvUnitDescriptor): Promise<KvUnitSnapshot> {
    return this.admit(() => this.readAdmitted(descriptor))
  }

  private async readAdmitted(descriptor: KvUnitDescriptor): Promise<KvUnitSnapshot> {
    this.assertDescriptor(descriptor)
    this.assertPreCommit()
    await this.rootGuard.observeCurrent(this.name)
    const stored = await readStoredUnit(this.root, this.name, this.signal)
    await this.rootGuard.observeCurrent(this.name)
    if (stored === undefined) {
      throw new StorageError('unit-not-found', `json unit '${this.name}' does not exist`)
    }
    validateStoredDescriptor(stored, descriptor)
    this.assertPreCommit()
    return snapshotOf(stored.state)
  }

  materializeMissing(
    descriptor: KvUnitDescriptor,
    snapshot: KvUnitSnapshot,
  ): Promise<KvClosedUnitMaterialization> {
    return this.admit(() => this.materializeMissingAdmitted(descriptor, snapshot))
  }

  private async materializeMissingAdmitted(
    descriptor: KvUnitDescriptor,
    snapshot: KvUnitSnapshot,
  ): Promise<KvClosedUnitMaterialization> {
    this.assertDescriptor(descriptor)
    this.assertPreCommit()
    assertLosslessJsonValue(snapshot, `unit '${descriptor.name}' materialization snapshot`)
    validateSnapshot(descriptor, snapshot)
    const state = stateOf(snapshot)
    const data = serialize(descriptor, state)
    this.assertPreCommit()
    await this.rootGuard.ensureCurrent(this.name)
    this.assertPreCommit()
    try {
      const publication = await this.publishMissing(
        join(this.root, `${this.name}.json`),
        data,
        this.signal,
        this.publicationGuard(),
      )
      if (publication.outcome === 'uncertain') {
        return new JsonUncertainMaterialization(this, descriptor, publication.cause)
      }
      return new JsonDurableMaterialization(this, descriptor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new StorageError(
          'target-exists',
          `json unit '${this.name}' already exists and cannot be materialized`,
          { cause: error },
        )
      }
      throw error
    }
  }

  expire(): void {
    this.active = false
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  readCommitted(descriptor: KvUnitDescriptor): Promise<KvUnitSnapshot> {
    return this.admit(() => this.readCommittedAdmitted(descriptor))
  }

  private async readCommittedAdmitted(descriptor: KvUnitDescriptor): Promise<KvUnitSnapshot> {
    await this.rootGuard.observeCurrent(this.name)
    const stored = await readStoredUnitWithoutCancellation(this.root, this.name)
    await this.rootGuard.observeCurrent(this.name)
    if (stored === undefined) {
      throw new StorageError('unit-not-found', `json unit '${this.name}' does not exist`)
    }
    validateStoredDescriptor(stored, descriptor)
    return snapshotOf(stored.state)
  }

  readUncertain(descriptor: KvUnitDescriptor): Promise<KvUnitSnapshot | undefined> {
    return this.admit(() => this.readUncertainAdmitted(descriptor))
  }

  private async readUncertainAdmitted(descriptor: KvUnitDescriptor): Promise<KvUnitSnapshot | undefined> {
    await this.rootGuard.observeCurrent(this.name)
    const stored = await readStoredUnitWithoutCancellation(this.root, this.name)
    await this.rootGuard.observeCurrent(this.name)
    if (stored === undefined) return undefined
    validateStoredDescriptor(stored, descriptor)
    return snapshotOf(stored.state)
  }

  private assertPreCommit(): void {
    this.signal.throwIfAborted()
  }

  private assertDescriptor(descriptor: KvUnitDescriptor): void {
    validateDescriptor(descriptor)
    if (descriptor.name !== this.name) {
      throw new Error(`cold lease for '${this.name}' cannot operate on unit '${descriptor.name}'`)
    }
  }

  private publicationGuard(): AtomicPublicationGuard {
    return { verify: () => this.rootGuard.observeCurrent(this.name) }
  }

  private admit<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.active) {
      return Promise.reject(new StorageError('closed', `json unit '${this.name}' cold lease is closed`))
    }
    const admitted = operation()
    this.inFlight.add(admitted)
    void admitted.then(
      () => { this.inFlight.delete(admitted) },
      () => { this.inFlight.delete(admitted) },
    )
    return admitted
  }
}

class JsonDurableMaterialization {
  readonly outcome = 'durable' as const
  constructor(
    private readonly lease: JsonClosedUnitLease,
    private readonly descriptor: KvUnitDescriptor,
  ) {}

  async readBack(): Promise<KvUnitSnapshot> {
    return this.lease.readCommitted(this.descriptor)
  }
}

class JsonUncertainMaterialization {
  readonly outcome = 'uncertain' as const

  constructor(
    private readonly lease: JsonClosedUnitLease,
    private readonly descriptor: KvUnitDescriptor,
    readonly cause: Error,
  ) {}

  async readBack(): Promise<KvUnitSnapshot | undefined> {
    try {
      return await this.lease.readUncertain(this.descriptor)
    } catch (error) {
      if (!isCommitOutcomeUnknownStorageError(this.cause)) throw error
      throw new StorageError(
        'commit-outcome-unknown',
        `json unit '${this.descriptor.name}' materialization and readback outcomes are unknown`,
        {
          cause: new AggregateError([
            this.cause,
            error instanceof Error ? error : new Error('json materialization readback failed', { cause: error }),
          ]),
        },
      )
    }
  }
}

async function readStoredUnit(
  root: string,
  name: string,
  signal: AbortSignal,
): Promise<StoredJsonUnit | undefined> {
  const text = await readUnitFile(root, name, signal)
  return text === undefined ? undefined : parseStoredJsonUnit(text, name)
}

async function readStoredUnitWithoutCancellation(
  root: string,
  name: string,
): Promise<StoredJsonUnit | undefined> {
  const text = await readUnitFile(root, name)
  return text === undefined ? undefined : parseStoredJsonUnit(text, name)
}

function inspectionOf(stored: StoredJsonUnit): KvClosedUnitInspection {
  return {
    name: stored.name,
    version: stored.version,
    hasGlobal: stored.hasGlobal,
    tables: [...stored.state.tables.keys()].sort(),
  }
}

function stateOf(snapshot: KvUnitSnapshot): UnitState {
  return {
    global: snapshot.global,
    tables: new Map(Object.entries(snapshot.tables).map(([table, records]) => [
      table,
      new Map(Object.entries(records)),
    ])),
  }
}

function validateSnapshot(descriptor: KvUnitDescriptor, snapshot: KvUnitSnapshot): void {
  const declared = [...descriptor.tables].sort()
  const provided = Object.keys(snapshot.tables).sort()
  if (declared.length !== provided.length
    || declared.some((table, index) => table !== provided[index])) {
    throw new StorageError(
      'malformed-medium',
      `unit '${descriptor.name}': snapshot table set differs from its descriptor`,
    )
  }
  if (!descriptor.hasGlobal && snapshot.global !== null) {
    throw new StorageError(
      'malformed-medium',
      `unit '${descriptor.name}': snapshot global is not declared by the descriptor`,
    )
  }
}
