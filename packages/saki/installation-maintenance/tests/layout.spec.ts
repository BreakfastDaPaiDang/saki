import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generationJsonLeaf,
  generationManifestReference,
  PENDING_OPERATION_LEAF,
  renderGenerationManifest,
  renderInstallationManifest,
  SETTLED_OPERATION_JOURNAL_LEAF,
  SETTLED_OPERATION_LEAF,
  selectSakiInstallationSource,
} from '../src/index.ts'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const BUILD_ID = 'saki-build-test' as SakiBuildId
const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-layout-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function writeSelected(rootPath: string): Promise<string> {
  const bytes = renderGenerationManifest(INSTALLATION_ID, GENERATION_ID, 3, BUILD_ID)
  const path = join(rootPath, ...generationJsonLeaf(GENERATION_ID).split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  const generation = JSON.parse(bytes.toString('utf8')) as Parameters<typeof renderInstallationManifest>[1]
  await writeFile(
    join(rootPath, 'installation.json'),
    renderInstallationManifest('ready', generation, generationManifestReference(GENERATION_ID, bytes)),
  )
  return join(dirname(path), 'state.sqlite')
}

describe('Saki Installation source selection', () => {
  it('uses only the exact manifest-selected generation even when other generations exist', async () => {
    const installationRoot = await root()
    const selectedPath = await writeSelected(installationRoot)
    await mkdir(join(installationRoot, 'generations', 'unselected'), { recursive: true })
    await writeFile(join(installationRoot, 'generations', 'unselected', 'state.sqlite'), 'ignored')
    const source = await selectSakiInstallationSource(
      installationRoot,
      join(installationRoot, 'control.sqlite'),
      AbortSignal.timeout(2_000),
    )
    expect(source).toMatchObject({ kind: 'selected-generation' })
    if (source.kind !== 'selected-generation') throw new Error('expected selected generation')
    expect(source.selected.databasePath).toBe(selectedPath)
  })

  it('uses only the exact configured legacy database when no manifest exists', async () => {
    const installationRoot = await root()
    const legacy = join(installationRoot, 'nested', 'control.sqlite')
    await mkdir(dirname(legacy), { recursive: true })
    await writeFile(legacy, 'B03')
    await writeFile(`${legacy}-wal`, 'wal')
    await expect(selectSakiInstallationSource(
      installationRoot,
      legacy,
      AbortSignal.timeout(2_000),
    )).resolves.toEqual({ kind: 'legacy-v2', databasePath: legacy })
  })

  it('ignores retained backup contents only while the exact legacy source still exists', async () => {
    const installationRoot = await root()
    const legacy = join(installationRoot, 'control.sqlite')
    await writeFile(legacy, 'B03')
    await mkdir(join(installationRoot, 'backups', 'backup-retained'), { recursive: true })
    await writeFile(join(installationRoot, 'backups', 'backup-retained', 'backup.json'), 'not authority')
    const signal = AbortSignal.timeout(2_000)

    await expect(selectSakiInstallationSource(installationRoot, legacy, signal))
      .resolves.toEqual({ kind: 'legacy-v2', databasePath: legacy })

    await rm(legacy)
    await expect(selectSakiInstallationSource(installationRoot, legacy, signal))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('classifies an empty root as fresh while ignoring only the fixed lock family', async () => {
    const installationRoot = await root()
    await writeFile(join(installationRoot, 'installation-lock.sqlite'), 'lock')
    await expect(selectSakiInstallationSource(
      installationRoot,
      join(installationRoot, 'control.sqlite'),
      AbortSignal.timeout(2_000),
    )).resolves.toEqual({ kind: 'fresh' })
  })

  it('classifies a missing Installation root as fresh', async () => {
    const installationRoot = join(await root(), 'missing')
    await expect(selectSakiInstallationSource(
      installationRoot,
      join(installationRoot, 'control.sqlite'),
      AbortSignal.timeout(2_000),
    )).resolves.toEqual({ kind: 'fresh' })
  })

  it('rejects in-memory and non-file legacy sources', async () => {
    const installationRoot = await root()
    await expect(selectSakiInstallationSource(
      installationRoot,
      ':memory:',
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'state-unsupported' })

    const legacy = join(installationRoot, 'control.sqlite')
    await mkdir(legacy)
    await expect(selectSakiInstallationSource(
      installationRoot,
      legacy,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('propagates a legacy-path filesystem error that is not absence', async () => {
    const installationRoot = await root()
    await expect(selectSakiInstallationSource(
      installationRoot,
      join(installationRoot, '\0'),
      AbortSignal.timeout(2_000),
    )).rejects.toThrow()
  })

  it('ignores only the fixed non-authority operation metadata files', async () => {
    const installationRoot = await root()
    for (const leaf of [
      PENDING_OPERATION_LEAF,
      SETTLED_OPERATION_LEAF,
      SETTLED_OPERATION_JOURNAL_LEAF,
    ]) {
      const path = join(installationRoot, ...leaf.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'settled metadata')
    }
    await expect(selectSakiInstallationSource(
      installationRoot,
      join(installationRoot, 'control.sqlite'),
      AbortSignal.timeout(2_000),
    )).resolves.toEqual({ kind: 'fresh' })
  })

  it.each([
    ['an orphan legacy sidecar', 'control.sqlite-wal'],
    ['an unrelated database', 'newer.sqlite'],
    ['an orphan operation journal', join('operations', 'operation-orphan.json')],
  ])('requires recovery for %s instead of discovering a source', async (_name, leaf) => {
    const installationRoot = await root()
    const path = join(installationRoot, leaf)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'residue')
    await expect(selectSakiInstallationSource(
      installationRoot,
      join(installationRoot, 'control.sqlite'),
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })
})
