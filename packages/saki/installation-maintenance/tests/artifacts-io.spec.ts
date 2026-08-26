import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type FailureMode =
  | 'normal'
  | 'initial-lstat-failure'
  | 'open-race'
  | 'open-failure'
  | 'sidecar-open-disappearance'
  | 'sidecar-opened-stat-disappearance'
  | 'sidecar-final-disappearance'
  | 'opened-stat-failure'
  | 'hash-race'
  | 'between-passes'
  | 'copy-failures'
  | 'hash-and-close-failures'
  | 'close-failure'

const filesystem = vi.hoisted(() => ({
  mode: 'normal' as FailureMode,
  lstatCounts: new Map<string, number>(),
  openCounts: new Map<string, number>(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  type Handle = Awaited<ReturnType<typeof original.open>>

  const next = (counts: Map<string, number>, path: string): number => {
    const value = (counts.get(path) ?? 0) + 1
    counts.set(path, value)
    return value
  }
  const shifted = <T extends object>(value: T): T => new Proxy(value, {
    get(target, property, receiver) {
      if (property === 'ctimeNs') {
        return Reflect.get(target, property, receiver) as bigint + 1n
      }
      return Reflect.get(target, property, receiver) as unknown
    },
  })

  return {
    ...original,
    lstat: (async (...args: Parameters<typeof original.lstat>) => {
      const path = String(args[0])
      if (filesystem.mode === 'initial-lstat-failure' && path.endsWith('state.sqlite')) {
        throw new Error('initial lstat failed')
      }
      const value = await original.lstat(...args)
      const count = next(filesystem.lstatCounts, path)
      if (filesystem.mode === 'sidecar-final-disappearance'
        && path.endsWith('-wal')
        && count % 2 === 0) {
        throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
      }
      return filesystem.mode === 'between-passes' && count >= 3
        ? shifted(value)
        : value
    }) as typeof original.lstat,
    open: async (...args: Parameters<typeof original.open>) => {
      const path = String(args[0])
      if (filesystem.mode === 'open-failure' && path.endsWith('state.sqlite')) {
        throw new Error('open failed')
      }
      if (filesystem.mode === 'sidecar-open-disappearance' && path.endsWith('-wal')) {
        await original.rm(args[0])
      }
      const handle = await original.open(...args)
      const count = next(filesystem.openCounts, path)
      let statCalls = 0
      const stat = async (...statArgs: Parameters<Handle['stat']>) => {
        statCalls += 1
        if (filesystem.mode === 'opened-stat-failure'
          && path.endsWith('state.sqlite')
          && statCalls === 1) {
          throw new Error('opened stat failed')
        }
        if (filesystem.mode === 'sidecar-opened-stat-disappearance'
          && path.endsWith('-wal')
          && statCalls === 1) {
          throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
        }
        const value = await handle.stat(...statArgs)
        if (filesystem.mode === 'open-race' && statCalls === 1) return shifted(value)
        if ((filesystem.mode === 'hash-race' || filesystem.mode === 'hash-and-close-failures')
          && statCalls === 2) return shifted(value)
        if (filesystem.mode === 'between-passes' && count >= 2) return shifted(value)
        return value
      }
      const close = async (): Promise<void> => {
        await handle.close()
        if (filesystem.mode === 'copy-failures'
          || filesystem.mode === 'hash-and-close-failures'
          || filesystem.mode === 'close-failure') {
          throw new Error(`closing ${path} failed`)
        }
      }
      const write = filesystem.mode === 'copy-failures' && String(args[1]) === 'wx'
        ? async (): Promise<never> => { throw new Error('copy write failed') }
        : handle.write.bind(handle)
      return {
        stat,
        read: handle.read.bind(handle),
        write,
        sync: handle.sync.bind(handle),
        close,
      } as unknown as Handle
    },
  }
})

import {
  assertSqliteArtifactSetUnchanged,
  captureSqliteArtifactSet,
  copySqliteArtifactSet,
} from '../src/artifacts.ts'

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-artifacts-io-'))
  roots.push(value)
  return value
}

function setMode(mode: FailureMode): void {
  filesystem.mode = mode
  filesystem.lstatCounts.clear()
  filesystem.openCounts.clear()
}

afterEach(async () => {
  setMode('normal')
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('SQLite artifact observation failures', () => {
  it('rejects a sidecar that disappears after its initial path observation', async () => {
    const directory = await root()
    const source = join(directory, 'state.sqlite')
    await writeFile(source, 'source')
    await writeFile(`${source}-wal`, 'wal')

    setMode('sidecar-open-disappearance')
    await expect(captureSqliteArtifactSet(source, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'source-changed' })
  })

  it('rejects a sidecar that disappears before its final path observation', async () => {
    const directory = await root()
    const source = join(directory, 'state.sqlite')
    await writeFile(source, 'source')
    await writeFile(`${source}-wal`, 'wal')

    setMode('sidecar-final-disappearance')
    await expect(captureSqliteArtifactSet(source, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'source-changed' })
  })

  it('rejects a sidecar whose opened handle disappears before identity verification', async () => {
    const directory = await root()
    const source = join(directory, 'state.sqlite')
    await writeFile(source, 'source')
    await writeFile(`${source}-wal`, 'wal')

    setMode('sidecar-opened-stat-disappearance')
    await expect(captureSqliteArtifactSet(source, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'source-changed' })
  })

  it.each([
    ['initial-lstat-failure', 'initial lstat failed'],
    ['open-failure', 'open failed'],
    ['opened-stat-failure', 'opened stat failed'],
  ] as const)('preserves a non-missing %s', async (mode, message) => {
    const directory = await root()
    const source = join(directory, 'state.sqlite')
    await writeFile(source, 'source')

    setMode(mode)
    await expect(captureSqliteArtifactSet(source, AbortSignal.timeout(2_000)))
      .rejects.toThrow(message)
  })

  it('rejects source replacement while opening, hashing, or comparing complete passes', async () => {
    const directory = await root()
    const source = join(directory, 'state.sqlite')
    await writeFile(source, 'source')

    setMode('open-race')
    await expect(captureSqliteArtifactSet(source, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'source-changed' })

    setMode('hash-race')
    await expect(captureSqliteArtifactSet(source, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'source-changed' })

    setMode('normal')
    const captured = await captureSqliteArtifactSet(source, AbortSignal.timeout(2_000))
    setMode('between-passes')
    await expect(assertSqliteArtifactSetUnchanged(captured, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'source-changed' })
  })

  it('reports a copy operation failure together with both close failures', async () => {
    const directory = await root()
    const sourceDirectory = join(directory, 'source')
    const targetDirectory = join(directory, 'target')
    await mkdir(sourceDirectory)
    await mkdir(targetDirectory)
    const source = join(sourceDirectory, 'state.sqlite')
    await writeFile(source, 'source')
    const captured = await captureSqliteArtifactSet(source, AbortSignal.timeout(2_000))

    setMode('copy-failures')
    const failure = await copySqliteArtifactSet(
      captured,
      join(targetDirectory, 'state.sqlite'),
      AbortSignal.timeout(2_000),
    ).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(3)
  })

  it('retains stable-digest operation and handle-close failures in causal order', async () => {
    const directory = await root()
    const source = join(directory, 'state.sqlite')
    await writeFile(source, 'source')

    setMode('hash-and-close-failures')
    const combined = await captureSqliteArtifactSet(
      source,
      AbortSignal.timeout(2_000),
    ).then(() => undefined, (error: unknown) => error)
    expect(combined).toBeInstanceOf(AggregateError)
    expect((combined as AggregateError).errors).toHaveLength(2)
    expect((combined as AggregateError).errors[0]).toMatchObject({ code: 'source-changed' })
    expect((combined as AggregateError).errors[1]).toMatchObject({
      message: `closing ${source} failed`,
    })

    setMode('close-failure')
    const closeOnly = await captureSqliteArtifactSet(
      source,
      AbortSignal.timeout(2_000),
    ).then(() => undefined, (error: unknown) => error)
    expect(closeOnly).not.toBeInstanceOf(AggregateError)
    expect(closeOnly).toMatchObject({ message: `closing ${source} failed` })
  })
})
