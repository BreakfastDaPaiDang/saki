import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import { runKvBackendContract, runKvClosedUnitContract } from '../../storage/tests/contract.ts'
import { Config, JsonStorageBackend, apply } from '../src/index.ts'
import { readUnitFile } from '../src/medium.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-json-'))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

const jsonContractHarness = async () => {
  const root = await freshRoot()
  return {
    backend: new JsonStorageBackend(root),
    reopen: async () => new JsonStorageBackend(root),
  }
}

runKvBackendContract('json', jsonContractHarness)
runKvClosedUnitContract('json', jsonContractHarness)

describe('json backend specifics', () => {
  const descriptor = { name: 'shape', version: 1, tables: ['t'], hasGlobal: true }

  it('publishes a human-readable pretty-printed file', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { hello: 'world' })
    const text = await readFile(join(root, 'shape.json'), 'utf8')
    expect(text).toBe(`${JSON.stringify(
      {
        unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: true },
        global: null,
        tables: { t: { k: { hello: 'world' } } },
      },
      null,
      2,
    )}\n`)
    await backend.close()
  })

  it('defers materialization until the first write', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await backend.kv.open(descriptor)
    await expect(readFile(join(root, 'shape.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await backend.close()
  })

  it('rejects materialization accessors without invoking them or creating the root', async () => {
    const outer = await freshRoot()
    const descriptorWithoutGlobal = { ...descriptor, hasGlobal: false }
    const cases: Array<readonly [string, () => { snapshot: KvUnitSnapshot; reads: () => number }]> = [
      ['snapshot tables', () => {
        let count = 0
        const snapshot = Object.defineProperty({ global: null }, 'tables', {
          enumerable: true,
          get: () => { count += 1; return { t: {} } },
        }) as KvUnitSnapshot
        return { snapshot, reads: () => count }
      }],
      ['table record map', () => {
        let count = 0
        const tables = Object.defineProperty({}, 't', {
          enumerable: true,
          get: () => { count += 1; return {} },
        }) as Record<string, Record<string, unknown>>
        return { snapshot: { tables, global: null }, reads: () => count }
      }],
      ['record value', () => {
        let count = 0
        const records = Object.defineProperty({}, 'key', {
          enumerable: true,
          get: () => { count += 1; return { value: 'read' } },
        }) as Record<string, unknown>
        return {
          snapshot: { tables: { t: records }, global: null },
          reads: () => count,
        }
      }],
    ]

    for (const [label, make] of cases) {
      const root = join(outer, label.replaceAll(' ', '_'))
      const backend = new JsonStorageBackend(root)
      const { snapshot, reads } = make()
      await expect(backend.kv.closed!.withReservedUnit(
        'shape',
        new AbortController().signal,
        lease => lease.materializeMissing(descriptorWithoutGlobal, snapshot),
      )).rejects.toThrow(/data property/)
      expect(reads()).toBe(0)
      await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
      await backend.close()
    }
  })

  it('resolves a relative storage root once at backend construction', async () => {
    const outer = await freshRoot()
    const firstCwd = join(outer, 'first')
    const secondCwd = join(outer, 'second')
    await mkdir(firstCwd)
    await mkdir(secondCwd)
    const originalCwd = process.cwd()
    try {
      process.chdir(firstCwd)
      const backend = new JsonStorageBackend('storage')
      process.chdir(secondCwd)
      const unit = await backend.kv.open(descriptor)
      await unit.putRecord('t', 'fixed', { root: 'first' })
      await backend.close()

      await expect(readFile(join(firstCwd, 'storage', 'shape.json'), 'utf8'))
        .resolves.toContain('"fixed"')
      await expect(readFile(join(secondCwd, 'storage', 'shape.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('rejects a malformed medium', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'shape.json'), 'not json at all', 'utf8')
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects nested duplicate members and lossy numeric tokens on ordinary open without changing the source', async () => {
    for (const [_label, source] of invalidLosslessDocuments()) {
      const root = await freshRoot()
      const path = join(root, 'shape.json')
      await writeFile(path, source, 'utf8')
      const backend = new JsonStorageBackend(root)

      await expect(backend.kv.open(descriptor)).rejects.toMatchObject({
        name: 'StorageError', code: 'malformed-medium',
      })
      await expect(readFile(path, 'utf8')).resolves.toBe(source)
      await backend.close()
    }
  })

  it('rejects nested duplicate members and lossy numeric tokens on closed read without changing the source', async () => {
    for (const [_label, source] of invalidLosslessDocuments()) {
      const root = await freshRoot()
      const path = join(root, 'shape.json')
      await writeFile(path, source, 'utf8')
      const backend = new JsonStorageBackend(root)

      await expect(backend.kv.closed!.withReservedUnit(
        'shape',
        new AbortController().signal,
        lease => lease.read(descriptor),
      )).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
      await expect(readFile(path, 'utf8')).resolves.toBe(source)
      await backend.close()
    }
  })

  it('rejects invalid UTF-8 on ordinary open without changing the source bytes', async () => {
    const root = await freshRoot()
    const path = join(root, 'shape.json')
    const source = invalidUtf8Document()
    await writeFile(path, source)
    const backend = new JsonStorageBackend(root)
    try {
      await expect(backend.kv.open(descriptor)).rejects.toMatchObject({
        name: 'StorageError', code: 'malformed-medium',
      })
      await expect(readFile(path)).resolves.toEqual(source)
    } finally {
      await backend.close()
    }
  })

  it('rejects invalid UTF-8 on closed read without changing the source bytes', async () => {
    const root = await freshRoot()
    const path = join(root, 'shape.json')
    const source = invalidUtf8Document()
    await writeFile(path, source)
    const backend = new JsonStorageBackend(root)
    try {
      await expect(backend.kv.closed!.withReservedUnit(
        'shape',
        new AbortController().signal,
        lease => lease.read(descriptor),
      )).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
      await expect(readFile(path)).resolves.toEqual(source)
    } finally {
      await backend.close()
    }
  })

  it('rejects a foreign unit header', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({
        unit: { name: 'other', version: 1, formatVersion: 1, hasGlobal: true },
        global: null,
        tables: { t: {} },
      }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects double-open of one unit as a plain caller error', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await backend.kv.open(descriptor)
    await expect(backend.kv.open(descriptor)).rejects.toThrow(/already open/)
    await backend.close()
  })

  it('rolls back memory when a publish fails', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    const committedRecord = { nested: { value: 'committed' } }
    const committedGlobal = { nested: { value: 'committed' } }
    await unit.putRecord('t', 'k', committedRecord)
    await unit.setGlobal(committedGlobal)
    committedRecord.nested.value = 'caller mutation'
    committedGlobal.nested.value = 'caller mutation'
    const path = join(root, 'shape.json')
    const backup = join(root, 'shape.committed.json')
    // A directory at the publish target rejects atomic replacement on every host.
    await rename(path, backup)
    await mkdir(path)
    await expect(unit.putRecord('t', 'k', { v: 'rejected' })).rejects.toThrow()
    await expect(unit.putRecord('t', 'k2', { v: 'also rejected' })).rejects.toThrow()
    await expect(unit.deleteRecord('t', 'k')).rejects.toThrow()
    await expect(unit.setGlobal({ g: 'rejected' })).rejects.toThrow()
    await rm(path, { recursive: true })
    await rename(backup, path)
    const snapshot = await unit.loadAll()
    expect(snapshot.tables['t']).toEqual({ k: { nested: { value: 'committed' } } })
    expect(snapshot.global).toEqual({ nested: { value: 'committed' } })
    // The next successful publish must not carry rejected writes to disk.
    await unit.putRecord('t', 'k3', { v: 'later' })
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('rejected')
    expect(text).not.toContain('caller mutation')
    await backend.close()
  })

  it('rejects undeclared table and global access as caller errors', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open({ name: 'shape', version: 1, tables: ['t'], hasGlobal: false })
    await expect(unit.putRecord('undeclared', 'k', {})).rejects.toThrow(/does not declare table/)
    await expect(unit.setGlobal({})).rejects.toThrow(/does not declare a global slot/)
    await backend.close()
  })

  it('rejects invalid unit and table names', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open({ ...descriptor, name: 'Bad-Name' })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await expect(backend.kv.open({ ...descriptor, tables: ['ok', 'not ok'] })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await backend.close()
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects an unversioned legacy JSON medium', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'contract_unit.json'),
      JSON.stringify({ unit: { name: 'contract_unit', version: 3 }, global: null, tables: { alpha: { k: 1 } } }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open({
      name: 'contract_unit', version: 3, tables: ['alpha', 'beta'], hasGlobal: true,
    })).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects a unit symlink without reading its target', async () => {
    const outer = await freshRoot()
    const root = join(outer, 'storage')
    const outside = join(outer, 'outside.json')
    const link = join(root, 'shape.json')
    await mkdir(root)
    await writeFile(outside, JSON.stringify({
      unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: true },
      global: null,
      tables: { t: {} },
    }), 'utf8')
    await symlink(outside, link, 'file')
    const before = await readFile(outside, 'utf8')
    const backend = new JsonStorageBackend(root)

    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({
      name: 'StorageError', code: 'malformed-medium',
    })
    expect(await readFile(outside, 'utf8')).toBe(before)
    await backend.close()
    await unlink(link)
  })

  it('classifies closed unit symlinks and dangling links as malformed instead of missing', async () => {
    const outer = await freshRoot()
    const root = join(outer, 'storage')
    const outside = join(outer, 'outside.json')
    const linked = join(root, 'shape.json')
    const dangling = join(root, 'dangling.json')
    await mkdir(root)
    await writeFile(outside, JSON.stringify({
      unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: true },
      global: null,
      tables: { t: {} },
    }), 'utf8')
    await symlink(outside, linked, 'file')
    await symlink(join(outer, 'absent.json'), dangling, 'file')
    const backend = new JsonStorageBackend(root)
    const signal = new AbortController().signal

    await expect(backend.kv.closed!.withReservedUnit(
      'shape', signal, lease => lease.inspect(),
    )).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await expect(backend.kv.closed!.withReservedUnit(
      'dangling', signal, lease => lease.inspect(),
    )).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await expect(backend.kv.closed!.withReservedUnit('dangling', signal, async (lease) => {
      await lease.materializeMissing(
        { name: 'dangling', version: 1, tables: ['t'], hasGlobal: false },
        { tables: { t: {} }, global: null },
      )
    })).rejects.toMatchObject({ name: 'StorageError', code: 'target-exists' })
    await backend.close()
    await unlink(linked)
    await unlink(dangling)
  })

  it('rejects a symbolic-link or junction storage root', async () => {
    const outer = await freshRoot()
    const realRoot = join(outer, 'real')
    const linkedRoot = join(outer, 'linked')
    await mkdir(realRoot)
    await symlink(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const backend = new JsonStorageBackend(linkedRoot)

    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({
      name: 'StorageError', code: 'malformed-medium',
    })
    await expect(backend.kv.closed!.withReservedUnit(
      'shape', new AbortController().signal, lease => lease.inspect(),
    )).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await backend.close()
    await unlink(linkedRoot)
  })

  it('rejects replacement of the storage root while reading a unit', async () => {
    const outer = await freshRoot()
    const root = join(outer, 'root')
    const retired = join(outer, 'retired')
    const replacement = join(outer, 'replacement')
    await mkdir(root)
    await mkdir(replacement)
    const document = (source: string) => JSON.stringify({
      unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: false },
      global: null,
      tables: { t: { source } },
    })
    await writeFile(join(root, 'shape.json'), document('original'), 'utf8')
    await writeFile(join(replacement, 'shape.json'), document('replacement'), 'utf8')

    await expect(readUnitFile(root, 'shape', undefined, async () => {
      await rename(root, retired)
      await rename(replacement, root)
    })).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
  })

  it('rejects an opened-unit write after the storage root is replaced', async () => {
    const outer = await freshRoot()
    const root = join(outer, 'root')
    const retired = join(outer, 'retired')
    await mkdir(root)
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'original', { source: 'original' })
    const original = await readFile(join(root, 'shape.json'), 'utf8')

    await rename(root, retired)
    await mkdir(root)
    await expect(unit.putRecord('t', 'redirected', { source: 'replacement' }))
      .rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })

    expect(await readFile(join(retired, 'shape.json'), 'utf8')).toBe(original)
    await expect(readFile(join(root, 'shape.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await backend.close()
  })

  it('rejects closed materialization after its observed storage root is replaced', async () => {
    const outer = await freshRoot()
    const root = join(outer, 'root')
    const retired = join(outer, 'retired')
    await mkdir(root)
    const backend = new JsonStorageBackend(root)
    const signal = new AbortController().signal

    await backend.kv.closed!.withReservedUnit('shape', signal, async (lease) => {
      await expect(lease.inspect()).resolves.toBeUndefined()
      await rename(root, retired)
      await mkdir(root)
      await expect(lease.materializeMissing(
        descriptor,
        { tables: { t: { redirected: { source: 'replacement' } } }, global: null },
      )).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    })

    await expect(readFile(join(retired, 'shape.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'shape.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await backend.close()
  })

  it('rejects a directory at a unit path as a malformed medium', async () => {
    const root = await freshRoot()
    await mkdir(join(root, 'shape.json'))
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({
      name: 'StorageError', code: 'malformed-medium',
    })
    await backend.close()
  })

  it('rejects malformed table shapes and foreign versions distinctly', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({
        unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: true },
        global: null,
        tables: { t: ['not', 'an', 'object'] },
      }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })

    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({
        unit: { name: 'shape', version: 9, formatVersion: 1, hasGlobal: true },
        global: null,
        tables: { t: {} },
      }),
      'utf8',
    )
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'version-mismatch' })

    await writeFile(join(root, 'shape.json'), JSON.stringify({
      unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: true }, global: null,
    }), 'utf8')
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })

    await writeFile(join(root, 'shape.json'), JSON.stringify('just a string'), 'utf8')
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects unsupported JSON formats and inexact ordinary-open layouts', async () => {
    const root = await freshRoot()
    const path = join(root, 'shape.json')
    const backend = new JsonStorageBackend(root)
    await writeFile(path, JSON.stringify({
      unit: { name: 'shape', version: 1, formatVersion: 2, hasGlobal: false },
      global: null,
      tables: { t: {} },
    }), 'utf8')
    await expect(backend.kv.open({ ...descriptor, hasGlobal: false }))
      .rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })

    await writeFile(path, JSON.stringify({
      unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: false },
      global: null,
      tables: { t: {} },
    }), 'utf8')
    await expect(backend.kv.open(descriptor))
      .rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await expect(backend.kv.open({ ...descriptor, hasGlobal: false, tables: ['t', 'extra'] }))
      .rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects unknown fields in a physical-v1 document', async () => {
    const root = await freshRoot()
    const path = join(root, 'shape.json')
    const backend = new JsonStorageBackend(root)
    await writeFile(path, JSON.stringify({
      unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: true },
      global: null,
      tables: { t: {} },
      futurePayload: { retained: true },
    }), 'utf8')
    await expect(backend.kv.open(descriptor))
      .rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })

    await writeFile(path, JSON.stringify({
      unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: true, futureHeader: true },
      global: null,
      tables: { t: {} },
    }), 'utf8')
    await expect(backend.kv.open(descriptor))
      .rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects non-lossless values in a physical-v1 document', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'shape.json'),
      '{"unit":{"name":"shape","version":1,"formatVersion":1,"hasGlobal":true},'
        + '"global":1e400,"tables":{"t":{}}}',
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    const signal = new AbortController().signal

    await expect(backend.kv.closed!.withReservedUnit(
      'shape', signal, lease => lease.inspect(),
    )).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await expect(backend.kv.open(descriptor))
      .rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await backend.close()
  })

  it.each([
    ['negative zero', '-0'],
    ['an unsafe integer', '9007199254740992'],
  ])('rejects %s in a stored unit version', async (_label, version) => {
    const root = await freshRoot()
    const path = join(root, 'shape.json')
    const bytes = Buffer.from(
      `{"unit":{"name":"shape","version":${version},"formatVersion":1,"hasGlobal":true},`
        + '"global":null,"tables":{"t":{}}}',
    )
    await writeFile(path, bytes)
    const backend = new JsonStorageBackend(root)
    const signal = new AbortController().signal

    await expect(backend.kv.closed!.withReservedUnit(
      'shape', signal, lease => lease.inspect(),
    )).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await expect(backend.kv.open(descriptor))
      .rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    expect(await readFile(path)).toEqual(bytes)
    await backend.close()
  })

  it('does not create a missing root while inspecting or reading a closed unit', async () => {
    const outer = await freshRoot()
    const root = join(outer, 'absent')
    const backend = new JsonStorageBackend(root)
    const signal = new AbortController().signal

    await expect(backend.kv.closed!.withReservedUnit(
      'shape', signal, lease => lease.inspect(),
    )).resolves.toBeUndefined()
    await expect(backend.kv.closed!.withReservedUnit(
      'shape', signal, lease => lease.read(descriptor),
    )).rejects.toMatchObject({ name: 'StorageError', code: 'unit-not-found' })
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    await backend.close()
  })

  it('inspects a closed unit without changing it and reports every stored table', async () => {
    const root = await freshRoot()
    const path = join(root, 'shape.json')
    const text = JSON.stringify({
      unit: { name: 'shape', version: 7, formatVersion: 1, hasGlobal: true },
      global: null,
      tables: { t: { current: 1 }, legacy: { retained: true } },
    })
    await writeFile(path, text, 'utf8')
    const backend = new JsonStorageBackend(root)

    await expect(backend.kv.closed!.withReservedUnit(
      'shape',
      new AbortController().signal,
      lease => lease.inspect(),
    )).resolves.toEqual({ name: 'shape', version: 7, hasGlobal: true, tables: ['legacy', 't'] })
    expect(await readFile(path, 'utf8')).toBe(text)
    await backend.close()
  })

  it('reads a complete detached snapshot from a closed unit without changing it', async () => {
    const root = await freshRoot()
    const path = join(root, 'shape.json')
    const document = {
      unit: { name: 'shape', version: 7, formatVersion: 1, hasGlobal: true },
      global: { mode: 'retained' },
      tables: { t: { current: { n: 1 } }, legacy: { old: { n: 0 } } },
    }
    const text = JSON.stringify(document)
    await writeFile(path, text, 'utf8')
    const backend = new JsonStorageBackend(root)

    await expect(backend.kv.closed!.withReservedUnit(
      'shape',
      new AbortController().signal,
      lease => lease.read({ name: 'shape', version: 7, tables: ['t', 'legacy'], hasGlobal: true }),
    )).resolves.toEqual({
      global: document.global,
      tables: document.tables,
    })
    expect(await readFile(path, 'utf8')).toBe(text)
    await backend.close()
  })

  it('rejects a closed read whose descriptor omits an actual stored table', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'shape.json'), JSON.stringify({
      unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: true },
      global: null,
      tables: { t: {}, legacy: {} },
    }), 'utf8')
    const backend = new JsonStorageBackend(root)

    await expect(backend.kv.closed!.withReservedUnit(
      'shape',
      new AbortController().signal,
      lease => lease.read({ name: 'shape', version: 1, tables: ['t'], hasGlobal: true }),
    )).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects a closed read whose descriptor changes the stored global layout', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'shape.json'), JSON.stringify({
      unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: false },
      global: null,
      tables: { t: {} },
    }), 'utf8')
    const backend = new JsonStorageBackend(root)

    await expect(backend.kv.closed!.withReservedUnit(
      'shape',
      new AbortController().signal,
      lease => lease.read({ name: 'shape', version: 1, tables: ['t'], hasGlobal: true }),
    )).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects closed-unit operations after the backend closes', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await backend.close()

    await expect(backend.kv.closed!.withReservedUnit(
      'shape', new AbortController().signal, lease => lease.inspect(),
    ))
      .rejects.toMatchObject({ name: 'StorageError', code: 'closed' })
  })

  it('reserves the unit name while a closed read is in flight', async () => {
    const root = await freshRoot()
    const path = join(root, 'shape.json')
    await writeFile(path, JSON.stringify({
      unit: { name: 'shape', version: 1, formatVersion: 1, hasGlobal: true },
      global: null,
      tables: { t: { large: 'x'.repeat(4 * 1024 * 1024) } },
    }), 'utf8')
    const backend = new JsonStorageBackend(root)
    const reading = backend.kv.closed!.withReservedUnit(
      'shape',
      new AbortController().signal,
      lease => lease.read({ name: 'shape', version: 1, tables: ['t'], hasGlobal: true }),
    )

    await expect(backend.kv.open({ name: 'shape', version: 1, tables: ['t'], hasGlobal: true }))
      .rejects.toMatchObject({ name: 'StorageError', code: 'unit-open' })
    await reading
    await backend.close()
  })

  it('rejects an inexact materialization snapshot without leaving a target', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const descriptor = { name: 'shape', version: 1, tables: ['t'], hasGlobal: false }
    const signal = new AbortController().signal

    await backend.kv.closed!.withReservedUnit('shape', signal, async (lease) => {
      await expect(lease.materializeMissing(descriptor, {
        tables: { t: {}, extra: {} }, global: null,
      })).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
      await expect(lease.materializeMissing(descriptor, {
        tables: { t: {} }, global: { forbidden: true },
      })).rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
      await expect(lease.inspect()).resolves.toBeUndefined()
    })
    await backend.close()
  })

  it('leaves no inspectable target when materialization serialization fails', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const descriptor = { name: 'shape', version: 1, tables: ['t'], hasGlobal: true }
    const signal = new AbortController().signal

    await backend.kv.closed!.withReservedUnit('shape', signal, async (lease) => {
      await expect(lease.materializeMissing(descriptor, {
        tables: { t: { bad: { unsupported: 1n } } }, global: null,
      })).rejects.toThrow(/JSON value/)
      await expect(lease.inspect()).resolves.toBeUndefined()
    })
    await backend.close()
  })

  it('keeps committed readback alive after late abort and expires callback-scoped capabilities', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const controller = new AbortController()
    let useExpiredLease!: () => Promise<unknown>
    let useExpiredCommit!: () => Promise<unknown>

    await backend.kv.closed!.withReservedUnit('shape', controller.signal, async (lease) => {
      const committed = await lease.materializeMissing(descriptor, {
        tables: { t: { kept: { value: 1 } } },
        global: null,
      })
      useExpiredLease = () => lease.inspect()
      useExpiredCommit = () => committed.readBack()
      controller.abort(new Error('late cancellation'))
      await expect(committed.readBack()).resolves.toEqual({
        tables: { t: { kept: { value: 1 } } },
        global: null,
      })
    })

    await expect(useExpiredLease()).rejects.toMatchObject({ name: 'StorageError', code: 'closed' })
    await expect(useExpiredCommit()).rejects.toMatchObject({ name: 'StorageError', code: 'closed' })
    await backend.close()
  })

  it('expires and releases a lease when its callback rejects', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const signal = new AbortController().signal
    let useExpiredLease!: () => Promise<unknown>

    await expect(backend.kv.closed!.withReservedUnit('shape', signal, async (lease) => {
      useExpiredLease = () => lease.inspect()
      throw new Error('callback failed')
    })).rejects.toThrow('callback failed')
    await expect(useExpiredLease()).rejects.toMatchObject({ name: 'StorageError', code: 'closed' })
    await expect(backend.kv.closed!.withReservedUnit(
      'shape', signal, lease => lease.inspect(),
    )).resolves.toBeUndefined()
    await backend.close()
  })

  it('registers callback completion before callback reentry can start backend close', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const signal = new AbortController().signal
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    let closeSettled = false
    let closing!: Promise<void>

    const held = backend.kv.closed!.withReservedUnit('shape', signal, async () => {
      closing = backend.close().then(() => { closeSettled = true })
      entered.resolve(undefined)
      await Promise.resolve()
      expect(closeSettled).toBe(false)
      await finish.promise
    })
    await entered.promise
    expect(closeSettled).toBe(false)
    finish.resolve(undefined)
    await held
    await closing
    expect(closeSettled).toBe(true)
  })

  it('registers on the hub via apply and closes on dispose', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(Storage)
    const fiber = await ctx.plugin({ apply, Config, inject: ['storage'] }, { root })
    const backend = ctx.storage.backend.get('json')
    expect(ctx.get(storageBackendServiceKey('json'))).toBe(backend)
    const unit = await backend.kv!.open(descriptor)
    await unit.putRecord('t', 'k', { v: 1 })
    await fiber.dispose()
    expect(() => ctx.storage.backend.get('json')).toThrow()
    expect(ctx.get(storageBackendServiceKey('json'))).toBeUndefined()
    await expect(unit.putRecord('t', 'x', {})).rejects.toMatchObject({ code: 'closed' })
  })

  it('registers and provides a configured backend name', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(Storage)
    const fiber = await ctx.plugin({ apply, Config, inject: ['storage'] }, { backend: 'source-json', root })
    const backend = ctx.storage.backend.get('source-json')
    expect(ctx.storage.backend.names()).toEqual(['source-json'])
    expect(ctx.get(storageBackendServiceKey('source-json'))).toBe(backend)

    await fiber.dispose()
    expect(ctx.storage.backend.names()).toEqual([])
    expect(ctx.get(storageBackendServiceKey('source-json'))).toBeUndefined()
  })

  it('close drains in-flight writes and blocks in-flight opens', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    const bigWrite = unit.putRecord('t', 'big', { blob: 'x'.repeat(4 * 1024 * 1024) })
    await unit.close()
    await expect(bigWrite).resolves.toBeUndefined()
    const onDisk = JSON.parse(await readFile(join(root, 'shape.json'), 'utf8')) as {
      tables: Record<string, Record<string, unknown>>
    }
    expect(onDisk.tables['t']?.['big']).toBeDefined()

    const backend2 = new JsonStorageBackend(root)
    const opening = backend2.kv.open(descriptor)
    const closing = backend2.close()
    await expect(opening.then(u => u.putRecord('t', 'x', {}))).rejects.toMatchObject({ code: 'closed' })
    await closing
  })
})

function invalidLosslessDocuments(): ReadonlyArray<readonly [string, string]> {
  const document = (global: string, tables = '{"t":{}}') =>
    `{"unit":{"name":"shape","version":1,"formatVersion":1,"hasGlobal":true},"global":${global},"tables":${tables}}`
  return [
    ['nested duplicate member', document('null', '{"t":{"record":{"nested":{"same":1,"same":2}}}}')],
    ['unsafe integer', document('{"value":9007199254740993}')],
    ['numeric underflow', document('{"value":1e-4000}')],
    ['numeric overflow', document('{"value":1e400}')],
  ]
}

function invalidUtf8Document(): Buffer {
  return Buffer.concat([
    Buffer.from('{"unit":{"name":"shape","version":1,"formatVersion":1,"hasGlobal":true},"global":{"value":"'),
    Buffer.from([0x80]),
    Buffer.from('"},"tables":{"t":{}}}'),
  ])
}
describe('per-record layout', () => {
  const descriptor = { name: 'recs', version: 2, layout: 'per-record' as const, tables: ['t'], hasGlobal: true }
  const recordPath = (root: string, key: string): string => join(root, 'recs', 't', `${key}.json`)

  it('stores one version-stamped document per record and defers materialization', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    // Missing directory = empty unit; nothing materialized on the medium yet.
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await unit.putRecord('t', 'k1', { v: 1 })
    await unit.putRecord('t', 'k2', { v: 2 })
    await unit.setGlobal('G')
    expect(await readFile(recordPath(root, 'k1'), 'utf8'))
      .toBe(`${JSON.stringify({ version: 2, record: { v: 1 } }, null, 2)}\n`)
    expect((await readdir(join(root, 'recs', 't'))).sort()).toEqual(['k1.json', 'k2.json'])
    expect(JSON.parse(await readFile(join(root, 'recs', 'global.json'), 'utf8')))
      .toEqual({ version: 2, record: 'G' })
    expect(await unit.loadAll()).toEqual({ tables: { t: { k1: { v: 1 }, k2: { v: 2 } } }, global: 'G' })
    await backend.close()
  })

  it('overwrites and deletes one document at a time and persists across reopen', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { v: 1 })
    await unit.putRecord('t', 'k', { v: 2 }) // overwrite the same document
    await unit.deleteRecord('t', 'missing') // idempotent no-op
    await unit.close()
    const unit2 = await backend.kv.open(descriptor)
    expect(await unit2.loadAll()).toEqual({ tables: { t: { k: { v: 2 } } }, global: null })
    await unit2.deleteRecord('t', 'k')
    expect(await unit2.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await backend.close()
  })

  it('rejects unsafe keys and undeclared tables, and enforces the closed guard', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await expect(unit.putRecord('t', 'a/b', {})).rejects.toThrow(/not path-safe/)
    await expect(unit.deleteRecord('t', '..')).rejects.toThrow(/not path-safe/)
    await expect(unit.putRecord('bogus', 'k', {})).rejects.toThrow(/does not declare table/)
    await unit.close()
    await expect(unit.putRecord('t', 'k', {})).rejects.toMatchObject({ code: 'closed' })
    await expect(unit.deleteRecord('t', 'k')).rejects.toMatchObject({ code: 'closed' })
    await expect(unit.setGlobal('x')).rejects.toMatchObject({ code: 'closed' })
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
    await backend.close()
  })

  it('discards foreign documents (stale version, malformed, non-object, unsafe key) on open', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'good', { v: 1 })
    await unit.close()
    await writeFile(recordPath(root, 'stale'), JSON.stringify({ version: 1, record: { v: 0 } }), 'utf8')
    await writeFile(recordPath(root, 'broken'), '{oops', 'utf8')
    await writeFile(recordPath(root, 'scalar'), JSON.stringify(5), 'utf8')
    await writeFile(recordPath(root, 'unsafe%2Fkey'), JSON.stringify({ version: 2, record: { v: 0 } }), 'utf8')
    await writeFile(join(root, 'recs', 't', 'not-json.txt'), 'ignored', 'utf8')
    await writeFile(join(root, 'recs', 'global.json'), JSON.stringify({ version: 1, record: 'old' }), 'utf8')
    // Stray unit-root entries: an undeclared directory and a non-document file.
    await mkdir(join(root, 'recs', 'stray-dir'), { recursive: true })
    await writeFile(join(root, 'recs', 'stray.txt'), 'ignored', 'utf8')
    const unit2 = await backend.kv.open(descriptor)
    expect(await unit2.loadAll()).toEqual({ tables: { t: { good: { v: 1 } } }, global: null })
    await backend.close()
  })

  it('propagates non-ENOENT read failures and refuses a global slot that is not declared', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    // A file where the unit directory should be: the lazy loadAll readdir
    // fails with ENOTDIR (opening itself touches nothing on the medium).
    await writeFile(join(root, 'recs'), 'not a directory', 'utf8')
    const unit = await backend.kv.open(descriptor)
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'ENOTDIR' })
    await unit.close()
    const noGlobal = { name: 'plain', version: 1, layout: 'per-record' as const, tables: ['t'], hasGlobal: false }
    const unit2 = await backend.kv.open(noGlobal)
    await expect(unit2.setGlobal('x')).rejects.toThrow(/does not declare a global slot/)
    await backend.close()
  })

  it('close drains in-flight writes and an unreadable record document reads as absent', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    const big = unit.putRecord('t', 'big', { blob: 'x'.repeat(4 * 1024 * 1024) })
    await unit.close()
    await unit.close() // idempotent
    await expect(big).resolves.toBeUndefined()
    const onDisk = JSON.parse(await readFile(recordPath(root, 'big'), 'utf8')) as { record: { blob: string } }
    expect(onDisk.record).toEqual({ blob: 'x'.repeat(4 * 1024 * 1024) })
    await backend.close()
  })

  it('reads an unreadable record document as absent (per-record contract)', async () => {
    const root = await freshRoot()
    // A directory where the record document should be: readFile fails with
    // EISDIR on every platform (permission bits are unenforceable on win32).
    await mkdir(join(root, 'recs', 't', 'locked.json'), { recursive: true })
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await backend.close()
  })

  it('bootstraps an empty per-record tree from a legacy whole-unit file and preserves it', async () => {
    const root = await freshRoot()
    // A legacy single-layout file for the same unit and version; the extra
    // table is not declared and must be skipped.
    const legacy = JSON.stringify({
      unit: { name: 'recs', version: descriptor.version },
      global: null,
      tables: { t: { old1: { v: 1 }, old2: { v: 2 } }, undeclared: { k: { v: 0 } } },
    })
    await writeFile(join(root, 'recs.json'), legacy, 'utf8')
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { t: { old1: { v: 1 }, old2: { v: 2 } } }, global: null })
    await expect(readFile(join(root, 'recs.json'), 'utf8')).resolves.toBe(legacy)
    await unit.close()
    const unit2 = await backend.kv.open(descriptor)
    expect(await unit2.loadAll()).toEqual({ tables: { t: { old1: { v: 1 }, old2: { v: 2 } } }, global: null })
    await backend.close()
  })

  it('bootstraps from a legacy file only when its stored version is accepted', async () => {
    // Version 3 is neither current (2) nor declared compat: the legacy file
    // is left alone and the unit reads empty — migrating unvouched records
    // would stamp them current and surface as schema failures at the domain
    // layer instead of a discardable stale cache.
    const root = await freshRoot()
    const legacy = JSON.stringify({
      unit: { name: 'recs', version: 3 },
      global: null,
      tables: { t: { old: { v: 1 } } },
    })
    await writeFile(join(root, 'recs.json'), legacy, 'utf8')
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(recordPath(root, 'old'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'recs.json'), 'utf8')).resolves.toBe(legacy)
    await unit.close()
    await backend.close()

    // The same file bootstraps once version 3 is declared read-compatible…
    const root2 = await freshRoot()
    await writeFile(join(root2, 'recs.json'), legacy, 'utf8')
    const backend2 = new JsonStorageBackend(root2)
    const compat = { ...descriptor, version: 4, compatibleVersions: [3] }
    const unit2 = await backend2.kv.open(compat)
    expect(await unit2.loadAll()).toEqual({ tables: { t: { old: { v: 1 } } }, global: null })
    // …and the migrated documents are stamped with the CURRENT version.
    expect(JSON.parse(await readFile(join(root2, 'recs', 't', 'old.json'), 'utf8')))
      .toEqual({ version: 4, record: { v: 1 } })
    await unit2.close()
    await backend2.close()
  })

  it('backupRecord moves the document aside; reads see it absent and a write recreates it', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { v: 1 })
    const moved = await unit.backupRecord!('t', 'k')
    expect(moved).toMatch(/k\.json\.bak\.\d{12}$/)
    expect(JSON.parse(await readFile(moved, 'utf8'))).toEqual({ version: 2, record: { v: 1 } })
    await expect(readFile(recordPath(root, 'k'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // The moved file no longer ends in .json, so it reads as absent…
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    // …and the key is free for a fresh write.
    await unit.putRecord('t', 'k', { v: 2 })
    expect(await unit.loadAll()).toEqual({ tables: { t: { k: { v: 2 } } }, global: null })
    await expect(unit.backupRecord!('t', 'a/b')).rejects.toThrow(/not path-safe/)
    await unit.close()
    await expect(unit.backupRecord!('t', 'k')).rejects.toMatchObject({ code: 'closed' })
    await backend.close()
  })

  it('reads per-record documents stamped with a declared compat version and stamps writes current', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const compat = { ...descriptor, compatibleVersions: [1] }
    await mkdir(join(root, 'recs', 't'), { recursive: true })
    await writeFile(recordPath(root, 'oldrec'), JSON.stringify({ version: 1, record: { v: 'old' } }), 'utf8')
    await writeFile(recordPath(root, 'ancient'), JSON.stringify({ version: 0, record: { v: 'no' } }), 'utf8')
    const unit = await backend.kv.open(compat)
    // Version 1 is declared compat and served; version 0 is not and discards.
    expect(await unit.loadAll()).toEqual({ tables: { t: { oldrec: { v: 'old' } } }, global: null })
    await unit.putRecord('t', 'oldrec', { v: 'new' })
    expect(JSON.parse(await readFile(recordPath(root, 'oldrec'), 'utf8')))
      .toEqual({ version: 2, record: { v: 'new' } })
    await backend.close()
  })

  it('ignores the legacy whole-unit file when any new document path exists', async () => {
    const root = await freshRoot()
    const legacy = JSON.stringify({
      unit: { name: 'recs', version: descriptor.version },
      global: null,
      tables: { t: { old: { v: 1 } } },
    })
    await writeFile(join(root, 'recs.json'), legacy, 'utf8')
    await mkdir(join(root, 'recs', 't'), { recursive: true })
    await writeFile(recordPath(root, 'broken'), '{oops', 'utf8')
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(recordPath(root, 'old'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'recs.json'), 'utf8')).resolves.toBe(legacy)
    await backend.close()
  })

  it('leaves a foreign, shapeless, or malformed legacy file alone', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'recs.json'), JSON.stringify({ unit: { name: 'other', version: 3 }, tables: {} }), 'utf8')
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(join(root, 'recs.json'), 'utf8')).resolves.toContain('other')
    await unit.close()
    await backend.close()

    const root2 = await freshRoot()
    await writeFile(join(root2, 'recs.json'), JSON.stringify({ tables: { t: { k: { v: 1 } } } }), 'utf8')
    const backend2 = new JsonStorageBackend(root2)
    const unit2 = await backend2.kv.open(descriptor)
    expect(await unit2.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(join(root2, 'recs.json'), 'utf8')).resolves.toContain('tables')
    await backend2.close()

    const root3 = await freshRoot()
    // A directory where the legacy file should be: the migration read fails loudly.
    await mkdir(join(root3, 'recs.json'))
    const backend3 = new JsonStorageBackend(root3)
    const unit3 = await backend3.kv.open(descriptor)
    await expect(unit3.loadAll()).rejects.toMatchObject({ code: 'EISDIR' })
    await backend3.close()

    const root4 = await freshRoot()
    await writeFile(join(root4, 'recs.json'), 'not json at all', 'utf8')
    const backend4 = new JsonStorageBackend(root4)
    const unit4 = await backend4.kv.open(descriptor)
    expect(await unit4.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(join(root4, 'recs.json'), 'utf8')).resolves.toBe('not json at all')
    await backend4.close()

    const root5 = await freshRoot()
    // A current-version stamp so the shapeless `tables` is what stops the bootstrap.
    await writeFile(
      join(root5, 'recs.json'),
      JSON.stringify({ unit: { name: 'recs', version: descriptor.version }, tables: 'not an object' }),
      'utf8',
    )
    const backend5 = new JsonStorageBackend(root5)
    const unit5 = await backend5.kv.open(descriptor)
    expect(await unit5.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(join(root5, 'recs.json'), 'utf8')).resolves.toContain('not an object')
    await backend5.close()

    await writeFile(
      join(root5, 'recs.json'),
      JSON.stringify({ unit: { name: 'recs', version: descriptor.version }, tables: null }),
      'utf8',
    )
    const backend6 = new JsonStorageBackend(root5)
    const unit6 = await backend6.kv.open(descriptor)
    expect(await unit6.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await backend6.close()
  })
})
