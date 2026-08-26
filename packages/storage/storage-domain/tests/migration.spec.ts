import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage, { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor, KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import {
  DomainFacility,
  defineDomain,
  defineDomainMigrations,
  descriptorOf,
  domainTable,
} from '../src/index.ts'
import type { DomainMigrationPlan } from '../src/index.ts'
import type { DomainChanged } from '../src/events.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const itemV1 = z.object({ label: z.string() }).strict()
const itemV2 = z.object({ label: z.string(), count: z.number().int() }).strict()
const audit = z.object({ migrated: z.boolean() }).strict()
const generation = z.object({ revision: z.number().int().nonnegative() }).strict()

const version1 = defineDomain({
  name: 'migratable',
  version: 1,
  tables: { items: domainTable<string, z.infer<typeof itemV1>>(itemV1) },
})

const version2 = defineDomain({
  name: 'migratable',
  version: 2,
  tables: {
    items: domainTable<string, z.infer<typeof itemV2>>(itemV2),
    audit: domainTable<string, z.infer<typeof audit>>(audit),
  },
})

const version3 = defineDomain({
  name: 'migratable',
  version: 3,
  global: { schema: generation, initial: { revision: 0 } },
  tables: {
    items: domainTable<string, z.infer<typeof itemV2>>(itemV2),
    audit: domainTable<string, z.infer<typeof audit>>(audit),
  },
})

const migrations = defineDomainMigrations({
  current: version3,
  steps: [
    {
      from: version1,
      to: version2,
      migrate: snapshot => ({
        tables: {
          items: Object.fromEntries(Object.entries(snapshot.tables['items'] ?? {}).map(([key, value]) => [
            key,
            { ...(value as z.infer<typeof itemV1>), count: 0 },
          ])),
          audit: {},
        },
        global: null,
      }),
    },
    {
      from: version2,
      to: version3,
      migrate: snapshot => ({ ...snapshot, global: { revision: 0 } }),
    },
  ],
})

async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const source = new MemoryStorageBackend()
  const target = new MemoryStorageBackend()
  ctx.storage.backend.register('source', source)
  ctx.storage.backend.register('target', target)
  const facility = new DomainFacility(ctx, { backend: 'source' })
  ctx.storage.mount('domain', facility)
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', change => changes.push(change))
  return { ctx, source, target, facility, changes }
}

async function materializeClosed(
  backend: MemoryStorageBackend,
  descriptor: KvUnitDescriptor,
  snapshot: KvUnitSnapshot,
  signal: AbortSignal,
): Promise<void> {
  await backend.kv.closed!.withReservedUnit(descriptor.name, signal, async (lease) => {
    await lease.materializeMissing(descriptor, snapshot)
  })
}

function inspectClosed(
  backend: MemoryStorageBackend,
  name: string,
  signal: AbortSignal,
) {
  return backend.kv.closed!.withReservedUnit(name, signal, lease => lease.inspect())
}

function readClosed(
  backend: MemoryStorageBackend,
  descriptor: KvUnitDescriptor,
  signal: AbortSignal,
) {
  return backend.kv.closed!.withReservedUnit(descriptor.name, signal, lease => lease.read(descriptor))
}

describe('defineDomainMigrations', () => {
  it('rejects an empty retained migration chain', () => {
    expect(() => defineDomainMigrations({
      current: version3,
      steps: [],
    })).toThrow(/retain at least one source version/)
  })

  it('rejects non-adjacent steps and chains that do not end at the current spec', () => {
    expect(() => defineDomainMigrations({
      current: version3,
      steps: [{ from: version1, to: version3, migrate: snapshot => snapshot }],
    })).toThrow(/adjacent/)
    expect(() => defineDomainMigrations({
      current: version3,
      steps: [{ from: version1, to: version2, migrate: snapshot => snapshot }],
    })).toThrow(/current version 3/)
  })

  it('rejects duplicate source versions and steps that name another domain', () => {
    expect(() => defineDomainMigrations({
      current: version3,
      steps: [
        { from: version1, to: version2, migrate: snapshot => snapshot },
        { from: version1, to: version2, migrate: snapshot => snapshot },
        { from: version2, to: version3, migrate: snapshot => snapshot },
      ],
    })).toThrow(/gap or a different schema declaration/)

    const foreign = defineDomain({ name: 'foreign', version: 2, tables: {} })
    expect(() => defineDomainMigrations({
      current: version3,
      steps: [{ from: version1, to: foreign, migrate: snapshot => snapshot }],
    })).toThrow(/names another domain/)
  })

  it('rejects a migration chain declared out of order', () => {
    expect(() => defineDomainMigrations({
      current: version3,
      steps: [
        { from: version2, to: version3, migrate: snapshot => snapshot },
        { from: version1, to: version2, migrate: snapshot => snapshot },
      ],
    })).toThrow(/gap or a different schema declaration/)
  })

  it('owns frozen spec containers that do not follow later declaration mutation', () => {
    const mutableV1 = defineDomain({
      name: 'isolated',
      version: 1,
      tables: { items: domainTable<string, z.infer<typeof itemV1>>(itemV1) },
    })
    const mutableV2 = defineDomain({
      name: 'isolated',
      version: 2,
      tables: { items: domainTable<string, z.infer<typeof itemV2>>(itemV2) },
    })
    const plan = defineDomainMigrations({
      current: mutableV2,
      steps: [{ from: mutableV1, to: mutableV2, migrate: snapshot => snapshot }],
    })

    ;(mutableV1 as { version: number }).version = 7
    Reflect.deleteProperty(mutableV1.tables, 'items')

    expect(plan.steps[0]!.from.version).toBe(1)
    expect(Object.keys(plan.steps[0]!.from.tables)).toEqual(['items'])
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.current)).toBe(true)
    expect(Object.isFrozen(plan.steps[0]!.from.tables)).toBe(true)
  })
})

describe('DomainFacility.migrate', () => {
  it('rejects a structurally forged non-adjacent plan before touching either backend', async () => {
    const { facility, target } = await harness()
    const signal = new AbortController().signal
    const forged = {
      current: version3,
      steps: [{ from: version1, to: version3, migrate: (snapshot: KvUnitSnapshot) => snapshot }],
    } as unknown as DomainMigrationPlan

    await expect(facility.migrate(forged, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'migration-plan' })
    await expect(inspectClosed(target, 'migratable', signal)).resolves.toBeUndefined()
  })

  it('validates and applies every adjacent step into a missing target without live events', async () => {
    const { facility, source, target, changes } = await harness()
    const signal = new AbortController().signal
    await materializeClosed(source, descriptorOf(version1), {
      tables: { items: { first: { label: 'retained' } } },
      global: null,
    }, signal)

    await expect(facility.migrate(migrations, {
      sourceBackend: 'source',
      targetBackend: 'target',
      signal,
    })).resolves.toEqual({
      domain: 'migratable',
      sourceVersion: 1,
      targetVersion: 3,
      steps: [{ from: 1, to: 2 }, { from: 2, to: 3 }],
    })

    await expect(readClosed(target, descriptorOf(version3), signal)).resolves.toEqual({
      tables: {
        items: { first: { label: 'retained', count: 0 } },
        audit: {},
      },
      global: { revision: 0 },
    })
    expect(changes).toEqual([])
  })

  it('rejects an invalid historical record before materializing the target', async () => {
    const { facility, source, target } = await harness()
    const signal = new AbortController().signal
    await materializeClosed(source, descriptorOf(version1), {
      tables: { items: { broken: { label: 42 } } },
      global: null,
    }, signal)

    await expect(facility.migrate(migrations, {
      sourceBackend: 'source',
      targetBackend: 'target',
      signal,
    })).rejects.toMatchObject({
      name: 'DomainError',
      code: 'invalid-record',
      detail: { table: 'items', key: 'broken' },
    })
    await expect(inspectClosed(target, 'migratable', signal)).resolves.toBeUndefined()
  })

  it('starts at every retained source version and applies only the remaining steps', async () => {
    const { facility, source, target } = await harness()
    const signal = new AbortController().signal
    await materializeClosed(source, descriptorOf(version2), {
      tables: {
        items: { first: { label: 'already-v2', count: 2 } },
        audit: { retained: { migrated: true } },
      },
      global: null,
    }, signal)

    const result = await facility.migrate(migrations, {
      sourceBackend: 'source',
      targetBackend: 'target',
      signal,
    })
    expect(result.steps).toEqual([{ from: 2, to: 3 }])
    expect((await readClosed(target, descriptorOf(version3), signal)).tables).toEqual({
      items: { first: { label: 'already-v2', count: 2 } },
      audit: { retained: { migrated: true } },
    })
  })

  it('rejects missing, unretained, and newer source versions without creating a target', async () => {
    const missing = await harness()
    const signal = new AbortController().signal
    await expect(missing.facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'migration-source-missing' })

    for (const version of [0, 4]) {
      const { facility, source, target } = await harness()
      source.pool.versions.set('migratable', version)
      source.pool.hasGlobals.set('migratable', false)
      source.pool.media.set('migratable', { tables: new Map(), global: null })
      await expect(facility.migrate(migrations, {
        sourceBackend: 'source', targetBackend: 'target', signal,
      })).rejects.toMatchObject({ code: 'migration-version' })
      await expect(inspectClosed(target, 'migratable', signal)).resolves.toBeUndefined()
    }
  })

  it('rejects unknown historical tables before invoking a step', async () => {
    const { facility, source, target } = await harness()
    const signal = new AbortController().signal
    source.pool.versions.set('migratable', 1)
    source.pool.hasGlobals.set('migratable', false)
    source.pool.media.set('migratable', {
      tables: new Map<string, Map<string, unknown>>([
        ['items', new Map<string, unknown>([['first', { label: 'retained' }]])],
        ['foreign', new Map<string, unknown>()],
      ]),
      global: null,
    })
    await expect(facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'migration-layout' })
    await expect(inspectClosed(target, 'migratable', signal)).resolves.toBeUndefined()
  })

  it('freezes step input and leaves the source unchanged when a step attempts mutation', async () => {
    const { facility, source, target } = await harness()
    const signal = new AbortController().signal
    await materializeClosed(source, descriptorOf(version1), {
      tables: { items: { first: { label: 'retained' } } },
      global: null,
    }, signal)
    const mutating = defineDomainMigrations({
      current: version2,
      steps: [{
        from: version1,
        to: version2,
        migrate: (snapshot) => {
          ;(snapshot.tables['items']!['first'] as { label: string }).label = 'mutated'
          return { tables: { items: {}, audit: {} }, global: null }
        },
      }],
    })

    await expect(facility.migrate(mutating, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'migration-step' })
    expect(await readClosed(source, descriptorOf(version1), signal)).toEqual({
      tables: { items: { first: { label: 'retained' } } },
      global: null,
    })
    await expect(inspectClosed(target, 'migratable', signal)).resolves.toBeUndefined()
  })

  it('rejects invalid adjacent output and an already materialized target', async () => {
    const invalid = await harness()
    const signal = new AbortController().signal
    await materializeClosed(invalid.source, descriptorOf(version1), {
      tables: { items: { first: { label: 'retained' } } },
      global: null,
    }, signal)
    const invalidOutput = defineDomainMigrations({
      current: version2,
      steps: [{
        from: version1,
        to: version2,
        migrate: () => ({ tables: { items: { first: { label: 'bad', count: 'NaN' } }, audit: {} }, global: null }),
      }],
    })
    await expect(invalid.facility.migrate(invalidOutput, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'invalid-record', detail: { table: 'items', key: 'first' } })

    const existing = await harness()
    await materializeClosed(existing.source, descriptorOf(version1), {
      tables: { items: { first: { label: 'retained' } } }, global: null,
    }, signal)
    await materializeClosed(existing.target, descriptorOf(version3), {
      tables: { items: {}, audit: {} }, global: { revision: 99 },
    }, signal)
    let sourceTouched = false
    const existingClosed = existing.source.kv.closed
    if (existingClosed === undefined) throw new Error('test backend lacks closed-unit support')
    const originalReserve = existingClosed.withReservedUnit.bind(existingClosed)
    const observedReserve: typeof existingClosed.withReservedUnit = (name, operationSignal, operation) =>
      originalReserve(name, operationSignal, lease => operation({
        ...lease,
        inspect: async () => {
          sourceTouched = true
          return await lease.inspect()
        },
        read: async (descriptor) => {
          sourceTouched = true
          return await lease.read(descriptor)
        },
      }))
    vi.spyOn(existingClosed, 'withReservedUnit').mockImplementation(observedReserve)
    await expect(existing.facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'target-exists' })
    expect(sourceTouched).toBe(false)
    expect((await readClosed(existing.target, descriptorOf(version3), signal)).global)
      .toEqual({ revision: 99 })
  })

  it('rejects lossy JavaScript values before adjacent schema parsing or publication', async () => {
    const { facility, source, target } = await harness()
    const signal = new AbortController().signal
    await materializeClosed(source, descriptorOf(version1), {
      tables: { items: { first: { label: 'retained' } } },
      global: null,
    }, signal)
    const lossyOutput = defineDomainMigrations({
      current: version2,
      steps: [{
        from: version1,
        to: version2,
        migrate: () => ({
          tables: { items: { first: { label: 'valid', count: -0 } }, audit: {} },
          global: null,
        }),
      }],
    })

    await expect(facility.migrate(lossyOutput, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'migration-layout' })
    await expect(inspectClosed(target, 'migratable', signal)).resolves.toBeUndefined()
  })

  it('fails loud when either backend lacks closed operations and honors cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const source = new MemoryStorageBackend(new MemoryMediaPool())
    ctx.storage.backend.register('source', source)
    ctx.storage.backend.register('target', {
      kv: { open: descriptor => source.kv.open(descriptor) },
      close: async () => {},
    })
    const facility = new DomainFacility(ctx, { backend: 'source' })
    const signal = new AbortController().signal
    await expect(facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'migration-unsupported' })

    const cancelled = await harness()
    const controller = new AbortController()
    controller.abort(new Error('migration cancelled'))
    await expect(cancelled.facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'target', signal: controller.signal,
    })).rejects.toThrow('migration cancelled')
  })

  it('requires distinct closed source and target media', async () => {
    const signal = new AbortController().signal

    const sameName = await harness()
    await expect(sameName.facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'source', signal,
    })).rejects.toMatchObject({ code: 'migration-unsupported' })

    const sameMedium = await harness()
    sameMedium.ctx.storage.backend.register('alias', sameMedium.source)
    await expect(sameMedium.facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'alias', signal,
    })).rejects.toMatchObject({ code: 'migration-unsupported' })

    const missingSourceClosed = await harness()
    missingSourceClosed.ctx.storage.backend.register('plain-source', {
      kv: { open: descriptor => missingSourceClosed.source.kv.open(descriptor) },
      close: async () => {},
    })
    await expect(missingSourceClosed.facility.migrate(migrations, {
      sourceBackend: 'plain-source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'migration-unsupported' })

    const missingTargetClosed = await harness()
    missingTargetClosed.ctx.storage.backend.register('plain-target', {
      kv: { open: descriptor => missingTargetClosed.target.kv.open(descriptor) },
      close: async () => {},
    })
    await expect(missingTargetClosed.facility.materialize(version3, {
      tables: { items: {}, audit: {} },
      global: { revision: 0 },
    }, { targetBackend: 'plain-target', signal }))
      .rejects.toMatchObject({ code: 'migration-unsupported' })
  })

  it('rejects current source state and historical global-layout drift', async () => {
    const signal = new AbortController().signal
    const current = await harness()
    current.source.pool.versions.set('migratable', version3.version)
    current.source.pool.hasGlobals.set('migratable', true)
    current.source.pool.media.set('migratable', {
      tables: new Map<string, Map<string, unknown>>([
        ['items', new Map<string, unknown>()],
        ['audit', new Map<string, unknown>()],
      ]),
      global: { revision: 0 },
    })
    await expect(current.facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toThrow(/already current/)

    const wrongGlobal = await harness()
    wrongGlobal.source.pool.versions.set('migratable', version1.version)
    wrongGlobal.source.pool.hasGlobals.set('migratable', true)
    wrongGlobal.source.pool.media.set('migratable', {
      tables: new Map<string, Map<string, unknown>>([['items', new Map<string, unknown>()]]),
      global: null,
    })
    await expect(wrongGlobal.facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'migration-layout' })
  })

  it('stops after a step-triggered abort without publishing and releases both reservations', async () => {
    const { facility, source, target } = await harness()
    const controller = new AbortController()
    await materializeClosed(source, descriptorOf(version1), {
      tables: { items: { first: { label: 'retained' } } },
      global: null,
    }, controller.signal)
    const cancellingPlan = defineDomainMigrations({
      current: version2,
      steps: [{
        from: version1,
        to: version2,
        migrate: (snapshot) => {
          controller.abort(new Error('cancelled inside migration step'))
          return {
            tables: {
              items: Object.fromEntries(Object.entries(snapshot.tables['items'] ?? {}).map(([key, value]) => [
                key,
                { ...(value as z.infer<typeof itemV1>), count: 0 },
              ])),
              audit: {},
            },
            global: null,
          }
        },
      }],
    })

    await expect(facility.migrate(cancellingPlan, {
      sourceBackend: 'source', targetBackend: 'target', signal: controller.signal,
    })).rejects.toThrow('cancelled inside migration step')

    const freshSignal = new AbortController().signal
    await expect(readClosed(source, descriptorOf(version1), freshSignal)).resolves.toMatchObject({
      tables: { items: { first: { label: 'retained' } } },
    })
    await expect(inspectClosed(target, 'migratable', freshSignal)).resolves.toBeUndefined()
  })

  it('reserves the domain against open and waits for admitted cold work during disposal', async () => {
    const { facility, source } = await harness()
    const signal = new AbortController().signal
    await materializeClosed(source, descriptorOf(version1), {
      tables: { items: { first: { label: 'retained' } } }, global: null,
    }, signal)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const sourceClosed = source.kv.closed
    if (sourceClosed === undefined) throw new Error('test backend lacks closed-unit support')
    const originalReserve = sourceClosed.withReservedUnit.bind(sourceClosed)
    const delayedReserve: typeof sourceClosed.withReservedUnit = (name, operationSignal, operation) =>
      originalReserve(name, operationSignal, async (lease) => {
        started.resolve(undefined)
        await release.promise
        return await operation(lease)
      })
    vi.spyOn(sourceClosed, 'withReservedUnit').mockImplementation(delayedReserve)

    const migration = facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })
    await started.promise
    await expect(facility.open(version3)).rejects.toMatchObject({ code: 'already-open' })
    await expect(facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'already-open' })
    await expect(facility.materialize(version3, {
      tables: { items: {}, audit: {} }, global: { revision: 0 },
    }, { targetBackend: 'target', signal })).rejects.toMatchObject({ code: 'already-open' })

    let disposed = false
    const closing = facility.closeAll().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await expect(migration).resolves.toMatchObject({ sourceVersion: 1, targetVersion: 3 })
    await closing
    expect(disposed).toBe(true)
    await expect(facility.open(version3)).rejects.toMatchObject({ code: 'closed' })
    await expect(facility.migrate(migrations, {
      sourceBackend: 'source', targetBackend: 'target', signal,
    })).rejects.toMatchObject({ code: 'closed' })
    await expect(facility.materialize(version3, {
      tables: { items: {}, audit: {} }, global: { revision: 0 },
    }, { targetBackend: 'target', signal })).rejects.toMatchObject({ code: 'closed' })
  })
})

describe('DomainFacility.materialize', () => {
  it('validates and reads back one complete missing domain without emitting live changes', async () => {
    const { facility, target, changes } = await harness()
    const signal = new AbortController().signal
    await expect(facility.materialize(version3, {
      tables: { items: { first: { label: 'fresh', count: 0 } }, audit: {} },
      global: { revision: 0 },
    }, { targetBackend: 'target', signal })).resolves.toEqual({
      domain: 'migratable',
      version: 3,
    })
    expect(await readClosed(target, descriptorOf(version3), signal)).toEqual({
      tables: { items: { first: { label: 'fresh', count: 0 } }, audit: {} },
      global: { revision: 0 },
    })
    expect(changes).toEqual([])
  })

  it('rejects invalid fresh data before creating the target', async () => {
    const { facility, target } = await harness()
    const signal = new AbortController().signal
    await expect(facility.materialize(version3, {
      tables: { items: { bad: { label: 'bad', count: 'NaN' } }, audit: {} },
      global: { revision: 0 },
    }, { targetBackend: 'target', signal })).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
    await expect(inspectClosed(target, 'migratable', signal)).resolves.toBeUndefined()
  })

  it.each([
    ['an incomplete snapshot', null],
    ['a non-object tables member', { tables: [], global: { revision: 0 } }],
    ['a non-object table member', { tables: { items: [], audit: {} }, global: { revision: 0 } }],
    ['an omitted table', { tables: { items: {} }, global: { revision: 0 } }],
    ['an undeclared global value', { tables: { items: {} }, global: { revision: 0 } }],
  ] as const)('rejects %s before creating the target', async (_label, snapshot) => {
    const { facility, target } = await harness()
    const signal = new AbortController().signal
    const spec = _label === 'an undeclared global value' ? version1 : version3
    await expect(facility.materialize(
      spec,
      snapshot as unknown as KvUnitSnapshot,
      { targetBackend: 'target', signal },
    )).rejects.toMatchObject({ code: 'migration-layout' })
    await expect(inspectClosed(target, 'migratable', signal)).resolves.toBeUndefined()
  })

  it('refuses an existing target before materialization', async () => {
    const { facility, target } = await harness()
    const signal = new AbortController().signal
    await materializeClosed(target, descriptorOf(version3), {
      tables: { items: {}, audit: {} }, global: { revision: 1 },
    }, signal)
    await expect(facility.materialize(version3, {
      tables: { items: {}, audit: {} }, global: { revision: 0 },
    }, { targetBackend: 'target', signal })).rejects.toMatchObject({ code: 'target-exists' })
    expect((await readClosed(target, descriptorOf(version3), signal)).global).toEqual({ revision: 1 })
  })

  it('finishes readback validation after publication despite a late abort', async () => {
    const { facility, target } = await harness()
    const controller = new AbortController()
    target.onMaterializeCommit = () => {
      controller.abort(new Error('late cancellation'))
    }

    await expect(facility.materialize(version3, {
      tables: { items: {}, audit: {} },
      global: { revision: 0 },
    }, { targetBackend: 'target', signal: controller.signal })).resolves.toEqual({
      domain: 'migratable',
      version: 3,
    })
    await expect(readClosed(
      target,
      descriptorOf(version3),
      new AbortController().signal,
    )).resolves.toEqual({
      tables: { items: {}, audit: {} },
      global: { revision: 0 },
    })
  })

  it('marks a readback validation failure as a committed target', async () => {
    const { facility, target } = await harness()
    const signal = new AbortController().signal
    target.onMaterializeCommit = () => {
      target.pool.media.get('migratable')!.tables.get('items')!
        .set('corrupted', { label: 'bad', count: 'NaN' })
    }

    await expect(facility.materialize(version3, {
      tables: { items: {}, audit: {} },
      global: { revision: 0 },
    }, { targetBackend: 'target', signal })).rejects.toMatchObject({
      code: 'migration-target-invalid',
      committed: true,
      detail: { table: 'items', key: 'corrupted' },
    })
    await expect(inspectClosed(target, 'migratable', signal)).resolves.toMatchObject({
      version: 3,
    })
  })

  it('marks a rejected durable readback as a committed but invalid target', async () => {
    const { facility, target } = await harness()
    const cause = new StorageError('malformed-medium', 'injected durable readback failure')
    target.materializationReadBackFailure = cause

    await expect(facility.materialize(version3, {
      tables: { items: {}, audit: {} },
      global: { revision: 0 },
    }, { targetBackend: 'target', signal: new AbortController().signal }))
      .rejects.toMatchObject({
        code: 'migration-target-invalid',
        committed: true,
        cause,
      })
  })

  it('rejects a schema-valid readback that differs from the requested snapshot', async () => {
    const mutations = [
      (target: MemoryStorageBackend) => {
        target.pool.media.get('migratable')!.tables.get('items')!.delete('first')
      },
      (target: MemoryStorageBackend) => {
        target.pool.media.get('migratable')!.tables.get('items')!
          .set('first', { label: 'changed', count: 0 })
      },
      (target: MemoryStorageBackend) => {
        target.pool.media.get('migratable')!.global = { revision: 1 }
      },
    ]
    for (const mutate of mutations) {
      const { facility, target } = await harness()
      target.onMaterializeCommit = () => { mutate(target) }

      await expect(facility.materialize(version3, {
        tables: { items: { first: { label: 'fresh', count: 0 } }, audit: {} },
        global: { revision: 0 },
      }, { targetBackend: 'target', signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'migration-target-invalid', committed: true })
    }
  })

  it('accepts a readback whose object members only differ in insertion order', async () => {
    const { facility, target } = await harness()
    target.onMaterializeCommit = () => {
      target.pool.media.get('migratable')!.tables.get('items')!
        .set('first', { count: 0, label: 'fresh' })
      target.pool.media.get('migratable')!.global = { revision: 0 }
    }

    await expect(facility.materialize(version3, {
      tables: { audit: {}, items: { first: { label: 'fresh', count: 0 } } },
      global: { revision: 0 },
    }, { targetBackend: 'target', signal: new AbortController().signal }))
      .resolves.toEqual({ domain: 'migratable', version: 3 })
  })

  it('compares arrays exactly during committed readback', async () => {
    const flexible = z.union([
      z.array(z.number()),
      z.object({ value: z.number() }).strict(),
    ])
    const arraySpec = defineDomain({
      name: 'array_readback',
      version: 1,
      tables: {},
      global: { schema: flexible, initial: [] },
    })
    const cases: Array<{
      requested: z.infer<typeof flexible>
      visible: z.infer<typeof flexible>
      exact: boolean
    }> = [
      { requested: [1], visible: { value: 1 }, exact: false },
      { requested: { value: 1 }, visible: [1], exact: false },
      { requested: [1], visible: [1, 2], exact: false },
      { requested: [1], visible: [2], exact: false },
      { requested: [1], visible: [1], exact: true },
    ]
    for (const scenario of cases) {
      const { facility, target } = await harness()
      target.onMaterializeCommit = () => {
        target.pool.media.get(arraySpec.name)!.global = scenario.visible
      }
      const result = facility.materialize(arraySpec, {
        tables: {}, global: scenario.requested,
      }, { targetBackend: 'target', signal: new AbortController().signal })
      if (scenario.exact) {
        await expect(result).resolves.toEqual({ domain: arraySpec.name, version: 1 })
      } else {
        await expect(result).rejects.toMatchObject({ code: 'migration-target-invalid', committed: true })
      }
    }
  })

  it('accepts the never-written sentinel for a declared global', async () => {
    const { facility } = await harness()
    await expect(facility.materialize(version3, {
      tables: { items: {}, audit: {} }, global: null,
    }, { targetBackend: 'target', signal: new AbortController().signal }))
      .resolves.toEqual({ domain: version3.name, version: version3.version })
  })

  it('compares raw readback before schema transforms can normalize a divergent value', async () => {
    const normalized = z.object({
      label: z.string().transform(value => value.trim()),
    }).strict()
    const normalizedSpec = defineDomain({
      name: 'normalized',
      version: 1,
      tables: { items: domainTable<string, z.output<typeof normalized>>(normalized) },
    })
    const { facility, target } = await harness()
    target.onMaterializeCommit = () => {
      target.pool.media.get('normalized')!.tables.get('items')!
        .set('first', { label: ' fresh ' })
    }

    await expect(facility.materialize(normalizedSpec, {
      tables: { items: { first: { label: 'fresh' } } },
      global: null,
    }, { targetBackend: 'target', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'migration-target-invalid', committed: true })
  })

  it('does not compare a matching raw readback after applying a non-idempotent transform again', async () => {
    const incremented = z.object({
      label: z.string().transform(value => `${value}!`),
    }).strict()
    const incrementedSpec = defineDomain({
      name: 'incremented',
      version: 1,
      tables: { items: domainTable<string, z.output<typeof incremented>>(incremented) },
    })
    const { facility } = await harness()

    await expect(facility.materialize(incrementedSpec, {
      tables: { items: { first: { label: 'fresh' } } },
      global: null,
    }, { targetBackend: 'target', signal: new AbortController().signal }))
      .resolves.toEqual({ domain: 'incremented', version: 1 })
  })

  it('reports a visible exact target with uncertain parent durability as committed', async () => {
    const { facility, target } = await harness()
    const cause = new Error('injected directory sync failure')
    target.materializationUncertainCause = cause

    await expect(facility.materialize(version3, {
      tables: { items: {}, audit: {} },
      global: { revision: 0 },
    }, { targetBackend: 'target', signal: new AbortController().signal }))
      .rejects.toMatchObject({
        code: 'migration-target-durability-uncertain', committed: true, cause,
      })
  })

  it('distinguishes an absent uncertain target from an indeterminate readback', async () => {
    const absent = await harness()
    absent.target.materializationUncertainCause = new Error('uncertain commit')
    absent.target.materializationReadBackMissing = true
    await expect(absent.facility.materialize(version3, {
      tables: { items: {}, audit: {} },
      global: { revision: 0 },
    }, { targetBackend: 'target', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'migration-target-not-committed', committed: undefined })

    const unknown = await harness()
    unknown.target.materializationUncertainCause = new Error('uncertain commit')
    unknown.target.materializationReadBackFailure = new Error('readback I/O failed')
    await expect(unknown.facility.materialize(version3, {
      tables: { items: {}, audit: {} },
      global: { revision: 0 },
    }, { targetBackend: 'target', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'migration-target-outcome-unknown', committed: undefined })
  })

  it('keeps an uncertain commit unknown when readback rejects as malformed or version-mismatched', async () => {
    for (const readBackFailure of [
      new StorageError('malformed-medium', 'injected malformed copied database'),
      new StorageError('version-mismatch', 'injected copied database version mismatch'),
    ]) {
      const { facility, target } = await harness()
      target.materializationUncertainCause = new Error('injected SQLite COMMIT uncertainty')
      target.materializationReadBackFailure = readBackFailure

      await expect(facility.materialize(version3, {
        tables: { items: {}, audit: {} },
        global: { revision: 0 },
      }, { targetBackend: 'target', signal: new AbortController().signal }))
        .rejects.toMatchObject({
          code: 'migration-target-outcome-unknown',
          committed: undefined,
        })
    }
  })
})
