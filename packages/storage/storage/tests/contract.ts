/**
 * Shared KV-backend conformance suite. Each backend's spec file calls
 * {@link runKvBackendContract} with a factory bound to its own medium; the
 * suite asserts every clause of the `src/backend.ts` contract so both
 * backends are held to identical semantics.
 * @module
 */

import { describe, expect, it } from 'vitest'
import type {
  KvClosedUnitLease,
  KvClosedUnitMaterialization,
  KvUnitDescriptor,
  KvUnitSnapshot,
  StorageBackend,
} from '../src/backend.ts'

/** One conformance run: a fresh backend plus a way to reopen the same medium (crash simulation). */
export interface KvBackendContractHarness {
  /** The backend under test, freshly created over an empty medium. */
  backend: StorageBackend
  /** Open a NEW backend instance over the SAME medium, as after a process restart. */
  reopen(): Promise<StorageBackend>
}

const DESCRIPTOR: KvUnitDescriptor = {
  name: 'contract_unit',
  version: 3,
  tables: ['alpha', 'beta'],
  hasGlobal: true,
}

const SNAPSHOT: KvUnitSnapshot = {
  tables: {
    alpha: {
      first: { n: 1 },
      'x\0y': { n: 2 },
      'x\0z': { n: 3 },
      '\ud800': { n: 4 },
      '\udc00': { n: 5 },
      '\ufffd': { n: 6 },
    },
    beta: { second: { ok: true } },
  },
  global: { counter: 7 },
}

/**
 * Run the shared conformance suite against one backend implementation.
 * @param label - Suite label, e.g. `json` / `sqlite`.
 * @param create - Factory producing a fresh harness per test.
 */
export function runKvBackendContract(label: string, create: () => Promise<KvBackendContractHarness>) {
  describe(`kv backend contract: ${label}`, () => {
    it('opens a missing unit as empty and serves loadAll immediately', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      const snapshot = await unit.loadAll()
      expect(snapshot.tables).toEqual({ alpha: {}, beta: {} })
      expect(snapshot.global).toBeNull()
      await backend.close()
    })

    it.each([
      ['negative zero', -0],
      ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ])('rejects %s as a descriptor version before opening the medium', async (_label, version) => {
      const { backend } = await create()
      try {
        await expect(backend.kv!.open({ ...DESCRIPTOR, version }))
          .rejects.toThrow(/non-negative safe integer/)
      } finally {
        await backend.close()
      }
    })

    it('round-trips records and global durably across reopen', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k1', { n: 1 })
      await unit.putRecord('alpha', 'k2', { n: 2 })
      await unit.putRecord('beta', 'weird key / with:stuff', { ok: true })
      await unit.setGlobal({ counter: 7 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      const unit2 = await reopened.kv!.open(DESCRIPTOR)
      const snapshot = await unit2.loadAll()
      expect(snapshot.tables['alpha']).toEqual({ k1: { n: 1 }, k2: { n: 2 } })
      expect(snapshot.tables['beta']).toEqual({ 'weird key / with:stuff': { ok: true } })
      expect(snapshot.global).toEqual({ counter: 7 })
      await reopened.close()
    })

    it('keeps every JavaScript string key distinct across delete and reopen', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      const keys = ['x\0y', 'x\0z', '\ud800', '\udc00', '\ufffd']
      for (const [ordinal, key] of keys.entries()) {
        await unit.putRecord('alpha', key, { ordinal })
      }

      await unit.deleteRecord('alpha', 'x\0y')
      let records = (await unit.loadAll()).tables['alpha']!
      expect(Object.hasOwn(records, 'x\0y')).toBe(false)
      expect(records['x\0z']).toEqual({ ordinal: 1 })
      await unit.putRecord('alpha', 'x\0y', { ordinal: 0 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      records = (await reopened.kv!.open(DESCRIPTOR).then(opened => opened.loadAll())).tables['alpha']!
      expect(Object.keys(records)).toHaveLength(keys.length)
      for (const [ordinal, key] of keys.entries()) {
        expect(Object.hasOwn(records, key)).toBe(true)
        expect(records[key]).toEqual({ ordinal })
      }
      await reopened.close()
    })

    it('putRecord overwrites and deleteRecord is idempotent', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k', { v: 'old' })
      await unit.putRecord('alpha', 'k', { v: 'new' })
      await unit.deleteRecord('alpha', 'k')
      await unit.deleteRecord('alpha', 'k')
      await unit.deleteRecord('alpha', 'never-existed')
      const snapshot = await unit.loadAll()
      expect(snapshot.tables['alpha']).toEqual({})
      await backend.close()
    })

    it('rejects lossy JSON values without poisoning later writes', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'kept', { value: 'before' })
      await expect(unit.putRecord('alpha', 'kept', { lost: undefined })).rejects.toThrow()
      await expect(unit.putRecord('alpha', 'infinite', { value: Number.POSITIVE_INFINITY })).rejects.toThrow()
      await expect(unit.setGlobal({ value: -0 })).rejects.toThrow()
      await expect(unit.loadAll()).resolves.toEqual({
        tables: { alpha: { kept: { value: 'before' } }, beta: {} },
        global: null,
      })
      await unit.putRecord('alpha', 'later', { value: 'valid' })
      await expect(unit.loadAll()).resolves.toMatchObject({
        tables: { alpha: { later: { value: 'valid' } } },
      })
      await backend.close()
    })

    it('borrows write inputs without retaining nested references', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      const record = { nested: { value: 'record before' }, list: [{ value: 1 }] }
      const global = { nested: { value: 'global before' } }

      await unit.putRecord('alpha', 'borrowed', record)
      await unit.setGlobal(global)
      record.nested.value = 'record after'
      record.list[0]!.value = 2
      global.nested.value = 'global after'
      await unit.putRecord('beta', 'later', { value: 'published later' })

      const expected = {
        tables: {
          alpha: {
            borrowed: { nested: { value: 'record before' }, list: [{ value: 1 }] },
          },
          beta: { later: { value: 'published later' } },
        },
        global: { nested: { value: 'global before' } },
      }
      await expect(unit.loadAll()).resolves.toEqual(expected)
      await harness.backend.close()

      const reopened = await harness.reopen()
      const reopenedUnit = await reopened.kv!.open(DESCRIPTOR)
      await expect(reopenedUnit.loadAll()).resolves.toEqual(expected)
      await reopened.close()
    })

    it('returns loadAll snapshots without lending nested state', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'owned', {
        nested: { value: 'record before' },
        list: [{ value: 1 }],
      })
      await unit.setGlobal({ nested: { value: 'global before' } })

      const borrowed = await unit.loadAll()
      const record = borrowed.tables['alpha']!['owned'] as {
        nested: { value: string }
        list: Array<{ value: number }>
      }
      const global = borrowed.global as { nested: { value: string } }
      record.nested.value = 'record after'
      record.list[0]!.value = 2
      global.nested.value = 'global after'
      borrowed.tables['alpha']!['injected'] = { value: 'snapshot only' }
      await unit.putRecord('beta', 'later', { value: 'published later' })

      const expected = {
        tables: {
          alpha: {
            owned: { nested: { value: 'record before' }, list: [{ value: 1 }] },
          },
          beta: { later: { value: 'published later' } },
        },
        global: { nested: { value: 'global before' } },
      }
      await expect(unit.loadAll()).resolves.toEqual(expected)
      await harness.backend.close()

      const reopened = await harness.reopen()
      const reopenedUnit = await reopened.kv!.open(DESCRIPTOR)
      await expect(reopenedUnit.loadAll()).resolves.toEqual(expected)
      await reopened.close()
    })

    it('rejects a version mismatch on reopen without touching the data', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k', { v: 1 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      await expect(reopened.kv!.open({ ...DESCRIPTOR, version: 4 })).rejects.toMatchObject({
        name: 'StorageError',
        code: 'version-mismatch',
      })
      // Original version still opens and still holds the data.
      const unit2 = await reopened.kv!.open(DESCRIPTOR)
      expect((await unit2.loadAll()).tables['alpha']).toEqual({ k: { v: 1 } })
      await reopened.close()
    })

    it('rejects operations after unit close, and close is idempotent', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.close()
      await unit.close()
      await expect(unit.putRecord('alpha', 'k', {})).rejects.toMatchObject({ code: 'closed' })
      await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
      await backend.close()
      await backend.close()
    })

    it('rejects new live-unit operations in the same turn that backend close begins', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      const closing = backend.close()
      const lateWrite = unit.putRecord('alpha', 'late', { value: true })
      try {
        await expect(lateWrite).rejects.toMatchObject({ code: 'closed' })
      } finally {
        await closing
      }
    })

  })
}

/**
 * Run the optional closed-unit conformance suite against one backend that
 * deliberately exposes `kv.closed`.
 * @param label - Suite label, e.g. `json` / `sqlite`.
 * @param create - Factory producing a fresh harness per test.
 */
export function runKvClosedUnitContract(label: string, create: () => Promise<KvBackendContractHarness>) {
  describe(`closed kv unit contract: ${label}`, () => {
    it.each([
      ['negative zero', -0],
      ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ])('rejects %s as a descriptor version before materialization', async (_label, version) => {
      const { backend } = await create()
      try {
        await expect(backend.kv!.closed!.withReservedUnit(
          DESCRIPTOR.name,
          new AbortController().signal,
          lease => lease.materializeMissing({ ...DESCRIPTOR, version }, SNAPSHOT),
        )).rejects.toThrow(/non-negative safe integer/)
      } finally {
        await backend.close()
      }
    })

    it('inspects a missing unit without creating it', async () => {
      const harness = await create()
      const signal = new AbortController().signal
      await expect(harness.backend.kv!.closed!.withReservedUnit(
        DESCRIPTOR.name,
        signal,
        lease => lease.inspect(),
      )).resolves.toBeUndefined()
      await harness.backend.close()

      const reopened = await harness.reopen()
      await expect(reopened.kv!.closed!.withReservedUnit(
        DESCRIPTOR.name,
        signal,
        lease => lease.inspect(),
      )).resolves.toBeUndefined()
      await reopened.close()
    })

    it('materializes and reads back one unit under the same reservation', async () => {
      const harness = await create()
      const { backend } = harness
      const signal = new AbortController().signal
      await backend.kv!.closed!.withReservedUnit(DESCRIPTOR.name, signal, async (lease) => {
        await expect(lease.inspect()).resolves.toBeUndefined()
        const committed = await lease.materializeMissing(DESCRIPTOR, SNAPSHOT)
        expect(committed.outcome).toBe('durable')
        await expect(lease.inspect()).resolves.toEqual({
          name: DESCRIPTOR.name,
          version: DESCRIPTOR.version,
          hasGlobal: true,
          tables: ['alpha', 'beta'],
        })
        await expect(committed.readBack()).resolves.toEqual(SNAPSHOT)
        await expect(lease.read(DESCRIPTOR)).resolves.toEqual(SNAPSHOT)
      })

      const unit = await backend.kv!.open(DESCRIPTOR)
      await expect(unit.loadAll()).resolves.toEqual(SNAPSHOT)
      await backend.close()

      const reopened = await harness.reopen()
      await expect(reopened.kv!.closed!.withReservedUnit(
        DESCRIPTOR.name,
        signal,
        lease => lease.read(DESCRIPTOR),
      )).resolves.toEqual(SNAPSHOT)
      await reopened.close()
    })

    it('refuses to overwrite a materialized target and preserves its snapshot', async () => {
      const { backend } = await create()
      const signal = new AbortController().signal
      await backend.kv!.closed!.withReservedUnit(DESCRIPTOR.name, signal, async (lease) => {
        await lease.materializeMissing(DESCRIPTOR, SNAPSHOT)
      })
      await backend.kv!.closed!.withReservedUnit(DESCRIPTOR.name, signal, async (lease) => {
        await expect(lease.materializeMissing(DESCRIPTOR, {
          ...SNAPSHOT,
          global: { counter: 99 },
        })).rejects.toMatchObject({ name: 'StorageError', code: 'target-exists' })
        await expect(lease.read(DESCRIPTOR)).resolves.toEqual(SNAPSHOT)
      })
      await backend.close()
    })

    it('rejects a lossy materialization snapshot without leaving a target', async () => {
      const { backend } = await create()
      const signal = new AbortController().signal
      await backend.kv!.closed!.withReservedUnit(DESCRIPTOR.name, signal, async (lease) => {
        await expect(lease.materializeMissing(DESCRIPTOR, {
          tables: {
            alpha: { lost: { value: undefined } },
            beta: {},
          },
          global: null,
        })).rejects.toThrow()
        await expect(lease.inspect()).resolves.toBeUndefined()
      })
      await backend.close()
    })

    it('rejects reservations while the unit is live or already reserved', async () => {
      const { backend } = await create()
      const signal = new AbortController().signal
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'key', { value: 1 })

      await expect(backend.kv!.closed!.withReservedUnit(
        DESCRIPTOR.name,
        signal,
        lease => lease.inspect(),
      )).rejects.toMatchObject({ name: 'StorageError', code: 'unit-open' })
      await unit.close()

      const finish = Promise.withResolvers<undefined>()
      const held = backend.kv!.closed!.withReservedUnit(DESCRIPTOR.name, signal, async () => {
        await finish.promise
      })
      await expect(backend.kv!.closed!.withReservedUnit(
        DESCRIPTOR.name,
        signal,
        lease => lease.inspect(),
      )).rejects.toMatchObject({ name: 'StorageError', code: 'unit-open' })
      await expect(backend.kv!.open(DESCRIPTOR))
        .rejects.toMatchObject({ name: 'StorageError', code: 'unit-open' })
      finish.resolve(undefined)
      await held
      await backend.close()
    })

    it('invalidates escaped leases and commit tokens after their callback settles', async () => {
      const { backend } = await create()
      const signal = new AbortController().signal
      let escapedLease: KvClosedUnitLease | undefined
      let escapedCommit: KvClosedUnitMaterialization | undefined

      await backend.kv!.closed!.withReservedUnit(DESCRIPTOR.name, signal, async (lease) => {
        escapedLease = lease
        escapedCommit = await lease.materializeMissing(DESCRIPTOR, SNAPSHOT)
      })

      await expect(escapedLease!.inspect())
        .rejects.toMatchObject({ name: 'StorageError', code: 'closed' })
      await expect(escapedCommit!.readBack())
        .rejects.toMatchObject({ name: 'StorageError', code: 'closed' })
      await backend.close()
    })

    it('invalidates an escaped lease after its callback rejects', async () => {
      const { backend } = await create()
      const signal = new AbortController().signal
      let escapedLease: KvClosedUnitLease | undefined

      await expect(backend.kv!.closed!.withReservedUnit(DESCRIPTOR.name, signal, async (lease) => {
        escapedLease = lease
        throw new Error('callback failed')
      })).rejects.toThrow('callback failed')
      await expect(escapedLease!.inspect())
        .rejects.toMatchObject({ name: 'StorageError', code: 'closed' })

      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.close()
      await backend.close()
    })

    it('rejects a pre-aborted reservation before invoking its callback', async () => {
      const { backend } = await create()
      const controller = new AbortController()
      controller.abort(new Error('contract cancelled'))
      let invoked = false

      await expect(backend.kv!.closed!.withReservedUnit(DESCRIPTOR.name, controller.signal, async () => {
        invoked = true
      })).rejects.toThrow('contract cancelled')
      expect(invoked).toBe(false)
      await backend.close()
    })

    it('waits for an admitted reservation during backend close', async () => {
      const { backend } = await create()
      const signal = new AbortController().signal
      const entered = Promise.withResolvers<undefined>()
      const finish = Promise.withResolvers<undefined>()
      let settled = false
      let closing: Promise<void> | undefined
      const held = backend.kv!.closed!.withReservedUnit(DESCRIPTOR.name, signal, async () => {
        closing = backend.close().then(() => { settled = true })
        entered.resolve(undefined)
        await finish.promise
      })
      await entered.promise

      await Promise.resolve()
      expect(settled).toBe(false)
      await expect(backend.kv!.closed!.withReservedUnit(
        'another-unit',
        signal,
        lease => lease.inspect(),
      )).rejects.toMatchObject({ name: 'StorageError', code: 'closed' })
      await expect(backend.kv!.open({ ...DESCRIPTOR, name: 'another-unit' }))
        .rejects.toMatchObject({ name: 'StorageError', code: 'closed' })
      finish.resolve(undefined)
      await held
      await closing
      expect(settled).toBe(true)
    })
  })
}
