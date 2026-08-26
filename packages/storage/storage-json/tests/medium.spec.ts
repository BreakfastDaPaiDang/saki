import {
  lstat as lstatPath,
  mkdtemp,
  open as openFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import type { BigIntStats, Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  ensureStorageRoot,
  readUnitFile,
  StorageRootGuard,
} from '../src/medium.ts'
import type { JsonMediumEffects } from '../src/medium.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-json-medium-'))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

const realEffects: JsonMediumEffects = {
  lstatPath: path => lstatPath(path),
  lstatPathBigInt: path => lstatPath(path, { bigint: true }),
  openRead: path => openFile(path, 'r'),
}

describe('JSON medium failure classification', () => {
  it('rejects disappearance after pinning and propagates an unrelated root probe failure', async () => {
    const root = await freshRoot()
    const guard = new StorageRootGuard(root)
    await guard.observeCurrent('unit')
    await rm(root, { recursive: true })
    await expect(guard.observeCurrent('unit')).rejects.toMatchObject({
      name: 'StorageError', code: 'malformed-medium',
    })

    const failure = errno('EACCES')
    const failingGuard = new StorageRootGuard(root, {
      ...realEffects,
      lstatPathBigInt: async () => { throw failure },
    })
    await expect(failingGuard.observeCurrent('unit')).rejects.toBe(failure)
  })

  it('propagates an unrelated existing-root probe failure', async () => {
    const root = await freshRoot()
    const failure = errno('EACCES')
    await expect(ensureStorageRoot(root, {
      ...realEffects,
      lstatPath: async () => { throw failure },
    })).rejects.toBe(failure)
  })

  it.each([
    ['root probe', 'root-stat', 'EACCES'],
    ['unit probe', 'unit-stat', 'EIO'],
    ['unit open', 'open', 'EACCES'],
    ['unit disappearance while opening', 'open', 'ENOENT'],
    ['unit disappearance after reading', 'post-unit-stat', 'ENOENT'],
    ['unit probe failure after reading', 'post-unit-stat', 'EIO'],
    ['root disappearance after reading', 'post-root-stat', 'ENOENT'],
    ['root probe failure after reading', 'post-root-stat', 'EIO'],
  ] as const)('classifies %s', async (_label, stage, code) => {
    const root = await freshRoot()
    const path = join(root, 'unit.json')
    await writeFile(path, 'content', 'utf8')
    const failure = errno(code)
    let rootProbes = 0
    let unitProbes = 0
    const effects: JsonMediumEffects = {
      ...realEffects,
      lstatPathBigInt: async (candidate) => {
        if (candidate === root) {
          rootProbes += 1
          if (stage === 'root-stat' || (stage === 'post-root-stat' && rootProbes === 2)) {
            throw failure
          }
        } else if (candidate === path) {
          unitProbes += 1
          if (stage === 'unit-stat' || (stage === 'post-unit-stat' && unitProbes === 2)) {
            throw failure
          }
        }
        return await realEffects.lstatPathBigInt(candidate)
      },
      openRead: async (candidate) => {
        if (stage === 'open') throw failure
        return await realEffects.openRead(candidate)
      },
    }

    const result = expect(readUnitFile(root, 'unit', undefined, undefined, effects)).rejects
    if (code === 'ENOENT') {
      await result.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    } else {
      await result.toBe(failure)
    }
  })

  it.each([
    ['opened identity', 'opened-identity'],
    ['opened type', 'opened-type'],
    ['read identity', 'read-identity'],
    ['final symlink type', 'final-symlink'],
    ['final non-file type', 'final-type'],
  ] as const)('rejects a changed %s', async (_label, stage) => {
    const root = await freshRoot()
    const path = join(root, 'unit.json')
    await writeFile(path, 'content', 'utf8')
    let unitProbes = 0
    const effects: JsonMediumEffects = {
      ...realEffects,
      lstatPathBigInt: async (candidate) => {
        const stat = await realEffects.lstatPathBigInt(candidate)
        if (candidate !== path) return stat
        unitProbes += 1
        if (unitProbes !== 2) return stat
        if (stage === 'final-symlink') return overrideStat(stat, { isSymbolicLink: () => true })
        if (stage === 'final-type') return overrideStat(stat, { isFile: () => false })
        return stat
      },
      openRead: async (candidate) => {
        const handle = await realEffects.openRead(candidate)
        if (stage === 'opened-identity' || stage === 'opened-type' || stage === 'read-identity') {
          const stat = handle.stat.bind(handle)
          let calls = 0
          vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
            const observed = await stat(options)
            if (!isBigIntStat(observed)) throw new Error('expected bigint file identity')
            calls += 1
            if (stage === 'opened-identity' && calls === 1) {
              return overrideStat(observed, { ino: observed.ino + 1n })
            }
            if (stage === 'opened-type' && calls === 1) {
              return overrideStat(observed, { isFile: () => false })
            }
            if (stage === 'read-identity' && calls === 2) {
              return overrideStat(observed, { ino: observed.ino + 1n })
            }
            return observed
          })
        }
        return handle
      },
    }

    await expect(readUnitFile(root, 'unit', undefined, undefined, effects)).rejects.toMatchObject({
      name: 'StorageError', code: 'malformed-medium',
    })
  })
})

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

function isBigIntStat(stat: Stats | BigIntStats): stat is BigIntStats {
  return typeof stat.ino === 'bigint'
}

function overrideStat(
  stat: BigIntStats,
  overrides: Partial<Record<'ino' | 'isFile' | 'isSymbolicLink', unknown>>,
): BigIntStats {
  return new Proxy(stat, {
    get: (target, property): unknown => {
      if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property)
      const value = Reflect.get(target, property, target) as unknown
      return value
    },
  })
}
