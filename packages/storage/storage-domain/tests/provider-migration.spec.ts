import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage from '@deepseek-ai/dsh-storage'
import type { KvUnitSnapshot, StorageBackend } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { createAtomicWriter } from '@deepseek-ai/dsh-storage-json/src/atomic.ts'
import { createClosedUnitOperations } from '@deepseek-ai/dsh-storage-json/src/closed.ts'
import { StorageRootGuard } from '@deepseek-ai/dsh-storage-json/src/medium.ts'
import { openSingleUnit } from '@deepseek-ai/dsh-storage-json/src/single-unit.ts'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  DomainFacility,
  defineDomain,
  defineDomainMigrations,
  descriptorOf,
  domainTable,
} from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const itemV1 = z.object({ label: z.string() }).strict()
const itemV2 = z.object({ label: z.string(), count: z.number().int() }).strict()

const version1 = defineDomain({
  name: 'provider_migration',
  version: 1,
  tables: { items: domainTable<string, z.infer<typeof itemV1>>(itemV1) },
})

const version2 = defineDomain({
  name: 'provider_migration',
  version: 2,
  tables: { items: domainTable<string, z.infer<typeof itemV2>>(itemV2) },
})

const version3 = defineDomain({
  name: 'provider_migration',
  version: 3,
  global: {
    schema: z.object({ revision: z.number().int().nonnegative() }).strict(),
    initial: { revision: 0 },
  },
  tables: { items: domainTable<string, z.infer<typeof itemV2>>(itemV2) },
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

const sourceSnapshot: KvUnitSnapshot = {
  tables: { items: { retained: { label: 'survives' } } },
  global: null,
}

type ProviderKind = 'json' | 'sqlite'

describe('real backend domain migration', () => {
  it.each([
    ['json', 'sqlite'],
    ['sqlite', 'json'],
  ] as const)('migrates every retained step from %s to %s and serves the committed target', async (sourceKind, targetKind) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-domain-provider-migration-'))
    roots.push(root)
    const source = backendFor(sourceKind, root, 'source')
    const target = backendFor(targetKind, root, 'target')
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('source', source)
    ctx.storage.backend.register('target', target)
    const changes: unknown[] = []
    ctx.on('domain/changed', change => changes.push(change))
    const signal = new AbortController().signal

    try {
      await source.kv!.closed!.withReservedUnit(version1.name, signal, async (lease) => {
        await lease.materializeMissing(descriptorOf(version1), sourceSnapshot)
      })

      const maintenance = new DomainFacility(ctx, { backend: 'source' })
      await expect(maintenance.migrate(migrations, {
        sourceBackend: 'source',
        targetBackend: 'target',
        signal,
      })).resolves.toMatchObject({
        sourceVersion: 1,
        targetVersion: 3,
        steps: [{ from: 1, to: 2 }, { from: 2, to: 3 }],
      })

      const targetServing = new DomainFacility(ctx, { backend: 'target' })
      const current = await targetServing.open(version3)
      expect(current.table('items').get('retained')).toEqual({ label: 'survives', count: 0 })
      expect(current.global.get()).toEqual({ revision: 0 })
      await current.close()

      const sourceServing = new DomainFacility(ctx, { backend: 'source' })
      const historical = await sourceServing.open(version1)
      expect(historical.table('items').get('retained')).toEqual({ label: 'survives' })
      await historical.close()
      expect(changes).toEqual([])
    } finally {
      await Promise.allSettled([source.close(), target.close()])
    }
  })

  it('poisons a live domain when JSON root replacement obscures a published write outcome', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'dsh-domain-root-write-'))
    roots.push(outer)
    const { backend, root, retired } = await rootReplacementBackend(outer)
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('swapped', backend)
    const facility = new DomainFacility(ctx, { backend: 'swapped' })
    const changes: unknown[] = []
    ctx.on('domain/changed', change => changes.push(change))
    const domain = await facility.open(version2)
    const table = domain.table('items')

    await expect(table.put('uncertain', { label: 'new', count: 1 }))
      .rejects.toMatchObject({ code: 'commit-outcome-unknown', publicationPossible: true })
    expect(changes).toEqual([])
    expect(() => table.get('uncertain'))
      .toThrow(expect.objectContaining({ code: 'write-outcome-uncertain' }))
    await expect(table.put('blocked', { label: 'blocked', count: 2 }))
      .rejects.toMatchObject({ code: 'write-outcome-uncertain' })
    await expect(readFile(join(retired, 'provider_migration.json'), 'utf8'))
      .resolves.toContain('"uncertain"')
    await expect(readFile(join(root, 'provider_migration.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await domain.close()
  })

  it('reports an unknown cold outcome when JSON root replacement follows link publication', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'dsh-domain-root-create-'))
    roots.push(outer)
    const { backend, root, retired } = await rootReplacementBackend(outer)
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('swapped', backend)
    const facility = new DomainFacility(ctx, { backend: 'swapped' })

    await expect(facility.materialize(version2, {
      tables: { items: { uncertain: { label: 'new', count: 1 } } },
      global: null,
    }, { targetBackend: 'swapped', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'migration-target-outcome-unknown', committed: undefined })
    await expect(readFile(join(retired, 'provider_migration.json'), 'utf8'))
      .resolves.toContain('"uncertain"')
    await expect(readFile(join(root, 'provider_migration.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})

function backendFor(kind: ProviderKind, root: string, role: string): StorageBackend {
  return kind === 'json'
    ? new JsonStorageBackend(join(root, `${role}-json`))
    : new SqliteStorageBackend({ path: join(root, `${role}.db`), journalMode: 'wal' })
}

async function rootReplacementBackend(outer: string): Promise<{
  readonly backend: StorageBackend
  readonly root: string
  readonly retired: string
}> {
  const root = join(outer, 'root')
  const retired = join(outer, 'retired')
  await mkdir(root)
  const rootGuard = new StorageRootGuard(root)
  let swapped = false
  const writer = createAtomicWriter({
    syncDirectory: async () => {
      if (swapped) return
      swapped = true
      await rename(root, retired)
      await mkdir(root)
    },
    removeTemporary: path => rm(path, { force: true }),
  })
  const backend: StorageBackend = {
    kv: {
      closed: createClosedUnitOperations(
        root,
        () => () => {},
        writer.writeAtomicCreate,
        rootGuard,
      ),
      open: async (descriptor) => {
        await rootGuard.ensureCurrent(descriptor.name)
        return await openSingleUnit(
          descriptor,
          root,
          () => {},
          writer.writeAtomic,
          rootGuard,
        )
      },
    },
    close: async () => {},
  }
  return { backend, root, retired }
}
