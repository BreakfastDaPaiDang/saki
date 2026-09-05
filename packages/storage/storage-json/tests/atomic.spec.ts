import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvClosedUnitLease, KvClosedUnitMaterialization } from '@deepseek-ai/dsh-storage'
import { createAtomicWriter } from '../src/atomic.ts'
import { createClosedUnitOperations } from '../src/closed.ts'
import { openSingleUnit } from '../src/single-unit.ts'
import { StorageRootGuard } from '../src/medium.ts'

describe('atomic JSON publication', () => {
  it('retains both durability and root failures when confirmation fails twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-atomic-double-confirmation-'))
    const target = join(root, 'unit.json')
    let probes = 0
    const writer = createAtomicWriter({
      syncDirectory: async () => { throw 'injected sync failure' },
      removeTemporary: path => rm(path, { force: true }),
    })

    const publication = writer.writeAtomic(target, 'published', {
      verify: async () => {
        probes += 1
        if (probes === 3) throw 'injected root failure'
      },
    })
    const error = await publication.catch((failure: unknown) => failure)
    expect(error).toMatchObject({ name: 'StorageError', code: 'commit-outcome-unknown' })
    expect((error as StorageError).cause).toBeInstanceOf(AggregateError)
    const causes = ((error as StorageError).cause as AggregateError).errors as Error[]
    expect(causes.map(cause => cause.cause)).toEqual([
      'injected sync failure',
      'injected root failure',
    ])
    await expect(readFile(target, 'utf8')).resolves.toBe('published')
  })

  it('reports uncertain durability without rolling back a renamed value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-atomic-'))
    const target = join(root, 'unit.json')
    const syncFailure = new Error('injected directory sync failure')
    await writeFile(target, 'old', 'utf8')
    const writer = createAtomicWriter({
      syncDirectory: async () => { throw syncFailure },
      removeTemporary: path => rm(path, { force: true }),
    })

    await expect(writer.writeAtomic(target, 'new')).rejects.toMatchObject({
      name: 'StorageError',
      code: 'durability-uncertain',
      published: true,
      cause: syncFailure,
    })
    await expect(readFile(target, 'utf8')).resolves.toBe('new')
  })

  it('keeps a directly opened unit aligned with an uncertain published write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-unit-'))
    const target = join(root, 'unit.json')
    const writer = createAtomicWriter({
      syncDirectory: async () => { throw new Error('injected directory sync failure') },
      removeTemporary: path => rm(path, { force: true }),
    })
    const unit = await openSingleUnit(
      { name: 'unit', version: 1, tables: ['records'], hasGlobal: false },
      root,
      () => {},
      writer.writeAtomic,
    )

    await expect(unit.putRecord('records', 'kept', { value: 'new' })).rejects.toMatchObject({
      code: 'durability-uncertain',
      published: true,
    })
    await expect(unit.loadAll()).rejects.toMatchObject({
      code: 'commit-outcome-unknown', publicationPossible: true,
    })
    await expect(unit.putRecord('records', 'blocked', { value: 'blocked' }))
      .rejects.toMatchObject({ code: 'commit-outcome-unknown' })
    await unit.close()
    const reopened = await openSingleUnit(
      { name: 'unit', version: 1, tables: ['records'], hasGlobal: false },
      root,
      () => {},
    )
    await expect(reopened.loadAll()).resolves.toMatchObject({
      tables: { records: { kept: { value: 'new' } } },
    })
    await expect(readFile(target, 'utf8')).resolves.toContain('"value": "new"')
    await reopened.close()
  })

  it('drains an admitted load before close completes and rejects later reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-unit-read-drain-'))
    const rootGuard = new StorageRootGuard(root)
    await rootGuard.ensureCurrent('unit')
    const unit = await openSingleUnit(
      { name: 'unit', version: 1, tables: ['records'], hasGlobal: false },
      root,
      () => {},
      undefined,
      rootGuard,
    )
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observeCurrent = rootGuard.observeCurrent.bind(rootGuard)
    vi.spyOn(rootGuard, 'observeCurrent').mockImplementation(async (name) => {
      entered.resolve(undefined)
      await release.promise
      await observeCurrent(name)
    })

    const loading = unit.loadAll()
    await entered.promise
    let closeSettled = false
    const closing = unit.close().then(() => { closeSettled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(closeSettled).toBe(false)
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })

    release.resolve(undefined)
    await expect(loading).resolves.toEqual({ tables: { records: {} }, global: null })
    await closing
  })

  it('returns an uncertain outcome without deleting a linked target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-create-'))
    const target = join(root, 'unit.json')
    const syncFailure = new Error('injected directory sync failure')
    const writer = createAtomicWriter({
      syncDirectory: async () => { throw syncFailure },
      removeTemporary: path => rm(path, { force: true }),
    })

    await expect(writer.writeAtomicCreate(
      target,
      'complete target',
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'uncertain', cause: syncFailure })
    await expect(readFile(target, 'utf8')).resolves.toBe('complete target')
  })

  it('leaves no target when cancellation rejects before linking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-create-abort-'))
    const target = join(root, 'unit.json')
    const controller = new AbortController()
    controller.abort(new Error('cancelled before publication'))
    const writer = createAtomicWriter({
      syncDirectory: async () => {},
      removeTemporary: path => rm(path, { force: true }),
    })

    await expect(writer.writeAtomicCreate(target, 'never published', controller.signal))
      .rejects.toThrow('cancelled before publication')
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('observes cancellation after a delayed root probe and before linking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-create-probe-abort-'))
    const target = join(root, 'unit.json')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let probes = 0
    const writer = createAtomicWriter({
      syncDirectory: async () => {},
      removeTemporary: path => rm(path, { force: true }),
    })
    const controller = new AbortController()
    const publication = writer.writeAtomicCreate(target, 'never linked', controller.signal, {
      verify: async () => {
        probes += 1
        if (probes === 1) {
          entered.resolve(undefined)
          await release.promise
        }
      },
    })

    await entered.promise
    controller.abort(new Error('cancelled during root probe'))
    release.resolve(undefined)
    await expect(publication).rejects.toThrow('cancelled during root probe')
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).filter(entry => entry.endsWith('.tmp'))).toEqual([])
  })

  it('never removes a string-path temporary entry after the root changes before publication', async () => {
    for (const operation of ['replace', 'create'] as const) {
      const outer = await mkdtemp(join(tmpdir(), `dsh-json-temp-root-${operation}-`))
      const root = join(outer, 'root')
      const retired = join(outer, 'retired')
      await mkdir(root)
      let cleanupCalls = 0
      let swapped = false
      const writer = createAtomicWriter({
        syncDirectory: async () => {},
        removeTemporary: async () => { cleanupCalls += 1 },
      })
      const guard = {
        verify: async () => {
          if (!swapped) {
            swapped = true
            await rename(root, retired)
            await mkdir(root)
          }
          throw new Error('observed root changed')
        },
      }
      const target = join(root, 'unit.json')

      const publication = operation === 'replace'
        ? writer.writeAtomic(target, 'not published', guard)
        : writer.writeAtomicCreate(target, 'not published', new AbortController().signal, guard)
      await expect(publication).rejects.toThrow('observed root changed')
      expect(cleanupCalls).toBe(0)
      expect((await readdir(retired)).filter(entry => entry.endsWith('.tmp'))).toHaveLength(1)
      await expect(readFile(join(retired, 'unit.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('preserves root-replacement evidence instead of cleaning a published temporary by path', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'dsh-json-temp-root-published-'))
    const root = join(outer, 'root')
    const retired = join(outer, 'retired')
    await mkdir(root)
    let cleanupCalls = 0
    let probes = 0
    const writer = createAtomicWriter({
      syncDirectory: async () => {},
      removeTemporary: async () => { cleanupCalls += 1 },
    })
    const guard = {
      verify: async () => {
        probes += 1
        if (probes === 4) {
          await rename(root, retired)
          await mkdir(root)
          throw new Error('observed root changed before cleanup')
        }
      },
    }
    const target = join(root, 'unit.json')

    const publication = await writer.writeAtomicCreate(
      target,
      'published in retired root',
      new AbortController().signal,
      guard,
    )
    expect(publication).toMatchObject({
      outcome: 'uncertain',
      cause: { code: 'commit-outcome-unknown', publicationPossible: true },
    })
    expect(cleanupCalls).toBe(0)
    await expect(readFile(join(retired, 'unit.json'), 'utf8')).resolves.toBe('published in retired root')
    expect((await readdir(retired)).filter(entry => entry.endsWith('.tmp'))).toHaveLength(1)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not delete a concurrent replacement after linking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-create-race-'))
    const target = join(root, 'unit.json')
    const replacement = join(root, 'replacement.json')
    const syncFailure = new Error('injected directory sync failure')
    const writer = createAtomicWriter({
      syncDirectory: async () => {
        await writeFile(replacement, 'concurrent replacement', 'utf8')
        await rename(replacement, target)
        throw syncFailure
      },
      removeTemporary: path => rm(path, { force: true }),
    })

    await expect(writer.writeAtomicCreate(
      target,
      'original publication',
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'uncertain', cause: syncFailure })
    await expect(readFile(target, 'utf8')).resolves.toBe('concurrent replacement')
  })

  it('does not turn durable publication into failure when redundant cleanup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-create-cleanup-'))
    const target = join(root, 'unit.json')
    const writer = createAtomicWriter({
      syncDirectory: async () => {},
      removeTemporary: async () => { throw new Error('injected cleanup failure') },
    })

    await expect(writer.writeAtomicCreate(
      target,
      'durable target',
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'durable' })
    await expect(readFile(target, 'utf8')).resolves.toBe('durable target')
  })

  it('keeps uncertain publication distinguishable when cleanup also fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-create-double-'))
    const target = join(root, 'unit.json')
    const syncFailure = new Error('injected directory sync failure')
    const cleanupFailure = new Error('injected cleanup failure')
    const writer = createAtomicWriter({
      syncDirectory: async () => { throw syncFailure },
      removeTemporary: async () => { throw cleanupFailure },
    })

    const result = await writer.writeAtomicCreate(
      target,
      'uncertain target',
      new AbortController().signal,
    )
    expect(result.outcome).toBe('uncertain')
    if (result.outcome === 'uncertain') {
      expect(result.cause).toBeInstanceOf(AggregateError)
      expect((result.cause as AggregateError).errors).toEqual([syncFailure, cleanupFailure])
    }
    await expect(readFile(target, 'utf8')).resolves.toBe('uncertain target')
  })

  it('returns an uncertain closed materialization with exact visible readback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-closed-'))
    const syncFailure = new Error('injected directory sync failure')
    const writer = createAtomicWriter({
      syncDirectory: async () => { throw syncFailure },
      removeTemporary: path => rm(path, { force: true }),
    })
    const closed = createClosedUnitOperations(root, () => () => {}, writer.writeAtomicCreate)
    const descriptor = { name: 'unit', version: 1, tables: ['records'], hasGlobal: false }
    const snapshot = { tables: { records: { kept: { value: 'new' } } }, global: null }

    await closed.withReservedUnit('unit', new AbortController().signal, async (lease) => {
      const materialization = await lease.materializeMissing(descriptor, snapshot)
      expect(materialization).toMatchObject({ outcome: 'uncertain', cause: syncFailure })
      await expect(materialization.readBack()).resolves.toEqual(snapshot)
    })
  })

  it('normalizes a non-Error reservation failure and releases a validated reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-reservation-failure-'))
    let releases = 0
    const reservationFailure = createClosedUnitOperations(root, () => { throw 'reservation failed' })
    await expect(reservationFailure.withReservedUnit(
      'unit', new AbortController().signal, lease => lease.inspect(),
    )).rejects.toMatchObject({ message: 'json closed-unit reservation failed', cause: 'reservation failed' })

    const validationFailure = createClosedUnitOperations(root, () => () => { releases += 1 })
    await expect(validationFailure.withReservedUnit(
      'Bad-Name', new AbortController().signal, lease => lease.inspect(),
    )).rejects.toMatchObject({ code: 'malformed-medium' })
    expect(releases).toBe(1)
  })

  it('propagates a non-EEXIST materialization publication failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-materialization-publish-'))
    const failure = new Error('publication failed before commit')
    const closed = createClosedUnitOperations(
      root,
      () => () => {},
      async () => { throw failure },
    )

    await expect(closed.withReservedUnit('unit', new AbortController().signal, lease =>
      lease.materializeMissing(
        { name: 'unit', version: 1, tables: ['records'], hasGlobal: false },
        { tables: { records: {} }, global: null },
      ),
    )).rejects.toBe(failure)
  })

  it('rejects a descriptor for a different cold lease name before filesystem access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-lease-name-'))
    const closed = createClosedUnitOperations(root, () => () => {})

    await expect(closed.withReservedUnit('unit', new AbortController().signal, lease =>
      lease.read({ name: 'other', version: 1, tables: [], hasGlobal: false }),
    )).rejects.toThrow("cold lease for 'unit' cannot operate on unit 'other'")
  })

  it('classifies absent durable and uncertain materialization readback distinctly', async () => {
    const descriptor = { name: 'unit', version: 1, tables: ['records'], hasGlobal: false }
    const snapshot = { tables: { records: {} }, global: null }
    for (const outcome of ['durable', 'uncertain'] as const) {
      const outer = await mkdtemp(join(tmpdir(), `dsh-json-${outcome}-readback-`))
      const root = join(outer, 'absent')
      const cause = new Error('uncertain publication')
      const closed = createClosedUnitOperations(
        root,
        () => () => {},
        async () => outcome === 'durable' ? { outcome } : { outcome, cause },
      )

      await closed.withReservedUnit('unit', new AbortController().signal, async (lease) => {
        const materialization = await lease.materializeMissing(descriptor, snapshot)
        if (outcome === 'durable') {
          await expect(materialization.readBack()).rejects.toMatchObject({ code: 'unit-not-found' })
        } else {
          await expect(materialization.readBack()).resolves.toBeUndefined()
        }
      })
    }
  })

  it('preserves an ordinary uncertain cause when visible readback is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-ordinary-uncertain-readback-'))
    const publicationCause = new Error('directory sync outcome unknown')
    const closed = createClosedUnitOperations(
      root,
      () => () => {},
      async (path) => {
        await writeFile(path, 'not JSON', 'utf8')
        return { outcome: 'uncertain', cause: publicationCause }
      },
    )

    await closed.withReservedUnit('unit', new AbortController().signal, async (lease) => {
      const materialization = await lease.materializeMissing(
        { name: 'unit', version: 1, tables: [], hasGlobal: false },
        { tables: {}, global: null },
      )
      await expect(materialization.readBack()).rejects.toMatchObject({ code: 'malformed-medium' })
    })
  })

  it('normalizes a non-Error readback failure after an unknown commit outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-unknown-readback-'))
    let published = false
    const rootGuard = {
      ensureCurrent: () => Promise.resolve(),
      observeCurrent: async () => {
        if (published) throw 'readback failed'
      },
    } as unknown as StorageRootGuard
    const publicationCause = new StorageError('commit-outcome-unknown', 'publication unknown')
    const closed = createClosedUnitOperations(
      root,
      () => () => {},
      async () => {
        published = true
        return { outcome: 'uncertain', cause: publicationCause }
      },
      rootGuard,
    )

    await closed.withReservedUnit('unit', new AbortController().signal, async (lease) => {
      const materialization = await lease.materializeMissing(
        { name: 'unit', version: 1, tables: [], hasGlobal: false },
        { tables: {}, global: null },
      )
      const error = await materialization.readBack().catch((failure: unknown) => failure)
      expect(error).toMatchObject({ code: 'commit-outcome-unknown' })
      const causes = ((error as StorageError).cause as AggregateError).errors as unknown[]
      expect(causes[0]).toBe(publicationCause)
      expect(causes[1]).toMatchObject({ message: 'json materialization readback failed', cause: 'readback failed' })
    })
  })

  it.each([
    ['deleteRecord', new StorageError('durability-uncertain', 'published')],
    ['deleteRecord', new StorageError('commit-outcome-unknown', 'unknown')],
    ['setGlobal', new StorageError('durability-uncertain', 'published')],
    ['setGlobal', new StorageError('commit-outcome-unknown', 'unknown')],
  ] as const)('poisons a direct unit when %s has %s publication evidence', async (operation, failure) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-json-${operation}-evidence-`))
    let fail = false
    const unit = await openSingleUnit(
      { name: 'unit', version: 1, tables: ['records'], hasGlobal: true },
      root,
      () => {},
      async () => {
        if (fail) throw failure
      },
    )
    if (operation === 'deleteRecord') await unit.putRecord('records', 'key', 'value')
    fail = true

    const write = operation === 'deleteRecord'
      ? unit.deleteRecord('records', 'key')
      : unit.setGlobal('value')
    await expect(write).rejects.toBe(failure)
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'commit-outcome-unknown' })
    await unit.close()
  })

  it('keeps an admitted unawaited lease method reserved through publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-closed-drain-'))
    const entered = Promise.withResolvers<undefined>()
    const releasePublication = Promise.withResolvers<undefined>()
    const primaryReleased = Promise.withResolvers<undefined>()
    const writer = createAtomicWriter({
      syncDirectory: async () => {},
      removeTemporary: path => rm(path, { force: true }),
    })
    const publish: typeof writer.writeAtomicCreate = async (...args) => {
      entered.resolve(undefined)
      await releasePublication.promise
      return await writer.writeAtomicCreate(...args)
    }
    let reserved = false
    let reservationCount = 0
    const rootGuard = {
      ensureCurrent: () => Promise.resolve(),
      observeCurrent: () => Promise.resolve(),
    } as unknown as StorageRootGuard
    const closed = createClosedUnitOperations(root, () => {
      if (reserved) throw new StorageError('unit-open', 'unit is already reserved')
      reserved = true
      const ordinal = ++reservationCount
      return () => {
        reserved = false
        if (ordinal === 1) primaryReleased.resolve(undefined)
      }
    }, publish, rootGuard)
    const descriptor = { name: 'unit', version: 1, tables: ['records'], hasGlobal: false }
    const snapshot = { tables: { records: { kept: { value: 'new' } } }, global: null }
    let escapedLease!: KvClosedUnitLease
    let materializing!: Promise<KvClosedUnitMaterialization>

    let scopeSettled = false
    const scoped = closed.withReservedUnit('unit', new AbortController().signal, async (lease) => {
      escapedLease = lease
      materializing = lease.materializeMissing(descriptor, snapshot)
    }).then(() => { scopeSettled = true })
    await entered.promise
    let closeSettled = false
    void primaryReleased.promise.then(() => { closeSettled = true })
    let committed: KvClosedUnitMaterialization | undefined
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(scopeSettled).toBe(false)
      expect(closeSettled).toBe(false)
      await expect(closed.withReservedUnit(
        'unit', new AbortController().signal, lease => lease.inspect(),
      )).rejects.toMatchObject({ code: 'unit-open' })
    } finally {
      releasePublication.resolve(undefined)
      const [materialization] = await Promise.allSettled([materializing, scoped])
      if (materialization.status === 'fulfilled') committed = materialization.value
    }
    if (committed === undefined) throw new Error('admitted materialization did not complete')
    expect(closeSettled).toBe(true)
    await expect(readFile(join(root, 'unit.json'), 'utf8')).resolves.toContain('"kept"')
    await expect(escapedLease.inspect()).rejects.toMatchObject({ code: 'closed' })
    await expect(committed.readBack()).rejects.toMatchObject({ code: 'closed' })
  })

  it('poisons a direct unit when the observed root changes after rename publication', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'dsh-json-root-write-'))
    const root = join(outer, 'root')
    const retired = join(outer, 'retired')
    await mkdir(root)
    const rootGuard = new StorageRootGuard(root)
    await rootGuard.ensureCurrent('unit')
    const writer = createAtomicWriter({
      syncDirectory: async () => {
        await rename(root, retired)
        await mkdir(root)
      },
      removeTemporary: path => rm(path, { force: true }),
    })
    const target = join(root, 'unit.json')
    const unit = await openSingleUnit(
      { name: 'unit', version: 1, tables: ['records'], hasGlobal: false },
      root,
      () => {},
      writer.writeAtomic,
      rootGuard,
    )

    await expect(unit.putRecord('records', 'uncertain', { value: 'new' }))
      .rejects.toMatchObject({ code: 'commit-outcome-unknown', publicationPossible: true })
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'commit-outcome-unknown' })
    await expect(unit.deleteRecord('records', 'uncertain'))
      .rejects.toMatchObject({ code: 'commit-outcome-unknown' })
    await expect(readFile(join(retired, 'unit.json'), 'utf8')).resolves.toContain('"uncertain"')
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await unit.close()
  })

  it('checks the observed root inside a wrapped publisher immediately before rename', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'dsh-json-root-before-write-'))
    const root = join(outer, 'root')
    const retired = join(outer, 'retired')
    await mkdir(root)
    const rootGuard = new StorageRootGuard(root)
    await rootGuard.ensureCurrent('unit')
    const writer = createAtomicWriter({
      syncDirectory: async () => {},
      removeTemporary: path => rm(path, { force: true }),
    })
    const publish = async (...args: Parameters<typeof writer.writeAtomic>): Promise<void> => {
      await rename(root, retired)
      await mkdir(root)
      await writer.writeAtomic(...args)
    }
    const unit = await openSingleUnit(
      { name: 'unit', version: 1, tables: ['records'], hasGlobal: false },
      root,
      () => {},
      publish,
      rootGuard,
    )

    await expect(unit.putRecord('records', 'blocked', { value: 'blocked' }))
      .rejects.toMatchObject({ code: 'malformed-medium' })
    await expect(readFile(join(retired, 'unit.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'unit.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'malformed-medium' })
    await unit.close()
  })

  it('returns uncertain closed evidence when the observed root changes after link publication', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'dsh-json-root-create-'))
    const root = join(outer, 'root')
    const retired = join(outer, 'retired')
    await mkdir(root)
    const rootGuard = new StorageRootGuard(root)
    await rootGuard.ensureCurrent('unit')
    const writer = createAtomicWriter({
      syncDirectory: async () => {
        await rename(root, retired)
        await mkdir(root)
      },
      removeTemporary: path => rm(path, { force: true }),
    })
    const closed = createClosedUnitOperations(
      root,
      () => () => {},
      writer.writeAtomicCreate,
      rootGuard,
    )
    const descriptor = { name: 'unit', version: 1, tables: ['records'], hasGlobal: false }
    const snapshot = { tables: { records: { uncertain: { value: 'new' } } }, global: null }

    await closed.withReservedUnit('unit', new AbortController().signal, async (lease) => {
      const materialization = await lease.materializeMissing(descriptor, snapshot)
      expect(materialization).toMatchObject({
        outcome: 'uncertain',
        cause: { code: 'commit-outcome-unknown', publicationPossible: true },
      })
      await expect(materialization.readBack())
        .rejects.toMatchObject({ code: 'commit-outcome-unknown', publicationPossible: true })
    })
    await expect(readFile(join(retired, 'unit.json'), 'utf8')).resolves.toContain('"uncertain"')
    await expect(readFile(join(root, 'unit.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
