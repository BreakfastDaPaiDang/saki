import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSqliteArtifactSetUnchanged,
  captureSqliteArtifactSet,
  copiedDatabasePath,
  copySqliteArtifactSet,
} from '../src/index.ts'

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-artifacts-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('SQLite artifact evidence', () => {
  it('captures and copies the database plus every extant sidecar exactly', async () => {
    const directory = await root()
    const sourceDirectory = join(directory, 'source')
    const targetDirectory = join(directory, 'target')
    await mkdir(sourceDirectory)
    await mkdir(targetDirectory)
    const source = join(sourceDirectory, 'state.sqlite')
    await writeFile(source, Buffer.from([0, 1, 2, 3]))
    await writeFile(`${source}-wal`, Buffer.from([4, 5]))
    await writeFile(`${source}-shm`, Buffer.from([6]))
    await writeFile(`${source}-journal`, Buffer.from([7, 8, 9]))

    const captured = await captureSqliteArtifactSet(source, AbortSignal.timeout(2_000))
    expect(captured.artifacts.map(value => [value.role, value.byteLength])).toEqual([
      ['database', 4],
      ['wal', 2],
      ['shm', 1],
      ['journal', 3],
    ])
    const target = join(targetDirectory, 'state.sqlite')
    const copied = await copySqliteArtifactSet(captured, target, AbortSignal.timeout(2_000))
    expect(copied.artifacts.map(value => [value.role, value.sha256])).toEqual(
      captured.artifacts.map(value => [value.role, value.sha256]),
    )
    for (const artifact of captured.artifacts) {
      expect(await readFile(`${target}${artifact.suffix}`)).toEqual(await readFile(artifact.path))
    }
  })

  it('detects any source byte or sidecar-set change', async () => {
    const directory = await root()
    const source = join(directory, 'state.sqlite')
    await writeFile(source, 'before')
    const captured = await captureSqliteArtifactSet(source, AbortSignal.timeout(2_000))
    await writeFile(source, 'after')
    await expect(assertSqliteArtifactSetUnchanged(
      captured,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'source-changed' })

    const recaptured = await captureSqliteArtifactSet(source, AbortSignal.timeout(2_000))
    await writeFile(`${source}-wal`, 'late')
    await expect(assertSqliteArtifactSetUnchanged(
      recaptured,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'source-changed' })
  })

  it('rejects orphan sidecars instead of inventing a database source', async () => {
    const directory = await root()
    const source = join(directory, 'state.sqlite')
    await writeFile(`${source}-wal`, 'orphan')
    await expect(captureSqliteArtifactSet(
      source,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('rejects non-regular sources and classifies a disappeared captured source as changed', async () => {
    const directory = await root()
    const source = join(directory, 'state.sqlite')
    await mkdir(source)
    await expect(captureSqliteArtifactSet(source, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'recovery-required' })

    await rm(source, { recursive: true })
    await writeFile(source, 'captured')
    const captured = await captureSqliteArtifactSet(source, AbortSignal.timeout(2_000))
    await rm(source)
    await expect(assertSqliteArtifactSetUnchanged(captured, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'source-changed' })
  })

  it('requires a sidecar-compatible leaf in a distinct copy directory', async () => {
    const directory = await root()
    const sourceDirectory = join(directory, 'source')
    const targetDirectory = join(directory, 'target')
    await mkdir(sourceDirectory)
    await mkdir(targetDirectory)
    const source = join(sourceDirectory, 'state.sqlite')
    await writeFile(source, 'source')
    const captured = await captureSqliteArtifactSet(source, AbortSignal.timeout(2_000))

    await expect(copySqliteArtifactSet(
      captured,
      join(targetDirectory, 'other.sqlite'),
      AbortSignal.timeout(2_000),
    )).rejects.toThrow('same database leaf')
    await expect(copySqliteArtifactSet(
      captured,
      join(sourceDirectory, 'state.sqlite'),
      AbortSignal.timeout(2_000),
    )).rejects.toThrow('different directory')
    expect(copiedDatabasePath(targetDirectory, source)).toBe(join(targetDirectory, 'state.sqlite'))
  })

  it('verifies each copied file against the evidence captured before copying', async () => {
    const directory = await root()
    const sourceDirectory = join(directory, 'source')
    const targetDirectory = join(directory, 'target')
    await mkdir(sourceDirectory)
    await mkdir(targetDirectory)
    const source = join(sourceDirectory, 'state.sqlite')
    await writeFile(source, 'source')
    const captured = await captureSqliteArtifactSet(source, AbortSignal.timeout(2_000))
    const mismatched = {
      ...captured,
      artifacts: captured.artifacts.map(artifact => ({ ...artifact, sha256: '0'.repeat(64) })),
    }

    await expect(copySqliteArtifactSet(
      mismatched,
      join(targetDirectory, 'state.sqlite'),
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'source-changed' })
  })

  it('never replaces a target file and rejects a copied set with divergent artifact roles', async () => {
    const directory = await root()
    const sourceDirectory = join(directory, 'source')
    const firstTargetDirectory = join(directory, 'target-existing')
    const secondTargetDirectory = join(directory, 'target-divergent')
    await mkdir(sourceDirectory)
    await mkdir(firstTargetDirectory)
    await mkdir(secondTargetDirectory)
    const source = join(sourceDirectory, 'state.sqlite')
    await writeFile(source, 'source')
    const captured = await captureSqliteArtifactSet(source, AbortSignal.timeout(2_000))
    const existingTarget = join(firstTargetDirectory, 'state.sqlite')
    await writeFile(existingTarget, 'valuable')

    await expect(copySqliteArtifactSet(
      captured,
      existingTarget,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(readFile(existingTarget, 'utf8')).resolves.toBe('valuable')

    const divergentRoles = {
      ...captured,
      artifacts: captured.artifacts.map(artifact => ({ ...artifact, role: 'wal' as const })),
    }
    await expect(copySqliteArtifactSet(
      divergentRoles,
      join(secondTargetDirectory, 'state.sqlite'),
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'source-changed' })
  })
})
