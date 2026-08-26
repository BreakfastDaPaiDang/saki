import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generationJsonLeaf,
  generationManifestReference,
  installationManifestSchema,
  readInstallationManifest,
  readSelectedGeneration,
  readUnselectedGeneration,
  renderGenerationManifest,
  renderInstallationManifest,
} from '../src/index.ts'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const OTHER_INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000099' as SakiInstallationId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const BUILD_ID = 'saki-build-test' as SakiBuildId
const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-manifest-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function writeValid(rootPath: string): Promise<void> {
  const generationBytes = renderGenerationManifest(INSTALLATION_ID, GENERATION_ID, 3, BUILD_ID)
  const generationPath = join(rootPath, ...generationJsonLeaf(GENERATION_ID).split('/'))
  await mkdir(dirname(generationPath), { recursive: true })
  await writeFile(generationPath, generationBytes)
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<typeof renderInstallationManifest>[1]
  await writeFile(
    join(rootPath, 'installation.json'),
    renderInstallationManifest('ready', generation, generationManifestReference(GENERATION_ID, generationBytes)),
  )
}

describe('Saki Installation manifests', () => {
  it('selects only the exact generation.json reference', async () => {
    const installationRoot = await root()
    await writeValid(installationRoot)
    const manifest = await readInstallationManifest(installationRoot, AbortSignal.timeout(2_000))
    expect(manifest?.value.phase).toBe('ready')
    const selected = await readSelectedGeneration(
      installationRoot,
      manifest!.value,
      AbortSignal.timeout(2_000),
    )
    expect(selected.generation).toMatchObject({
      installationId: INSTALLATION_ID,
      storageGenerationId: GENERATION_ID,
      stateVersion: 3,
      createdByBuildId: BUILD_ID,
    })
    expect(selected.databasePath).toBe(join(dirname(selected.generationManifestPath), 'state.sqlite'))
  })

  it('verifies one exact journal-named generation without an Installation manifest', async () => {
    const installationRoot = await root()
    await writeValid(installationRoot)
    await rm(join(installationRoot, 'installation.json'))

    const verified = await readUnselectedGeneration(
      installationRoot,
      INSTALLATION_ID,
      GENERATION_ID,
      AbortSignal.timeout(2_000),
    )

    expect(verified.generation).toMatchObject({
      installationId: INSTALLATION_ID,
      storageGenerationId: GENERATION_ID,
      createdByBuildId: BUILD_ID,
    })
    await expect(readUnselectedGeneration(
      installationRoot,
      'installation-00000000-0000-4000-8000-000000000099' as SakiInstallationId,
      GENERATION_ID,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'manifest-invalid' })
    await expect(readInstallationManifest(installationRoot, AbortSignal.timeout(2_000)))
      .resolves.toBeUndefined()
  })

  it('rejects traversal, identity mismatch, and unbounded generation leaves', () => {
    const base = {
      formatVersion: 1,
      phase: 'ready',
      installationId: INSTALLATION_ID,
      storageGenerationId: GENERATION_ID,
      stateVersion: 3,
      generationJson: { byteLength: 1, sha256: 'a'.repeat(64) },
    }
    expect(installationManifestSchema.safeParse({
      ...base,
      generationJson: { ...base.generationJson, leaf: '../generation.json' },
    }).success).toBe(false)
    expect(installationManifestSchema.safeParse({
      ...base,
      generationJson: {
        ...base.generationJson,
        leaf: 'generations/storage-generation-00000000-0000-4000-8000-000000000099/generation.json',
      },
    }).success).toBe(false)
    expect(installationManifestSchema.safeParse({
      ...base,
      generationJson: { ...base.generationJson, leaf: `generations/${'x'.repeat(300)}/generation.json` },
    }).success).toBe(false)
  })

  it('rejects changed generation bytes and duplicate manifest members', async () => {
    const installationRoot = await root()
    await writeValid(installationRoot)
    const manifest = (await readInstallationManifest(installationRoot, AbortSignal.timeout(2_000)))!.value
    const generationPath = join(installationRoot, ...manifest.generationJson.leaf.split('/'))
    await writeFile(generationPath, `${await (await import('node:fs/promises')).readFile(generationPath, 'utf8')} `)
    await expect(readSelectedGeneration(
      installationRoot,
      manifest,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'manifest-invalid' })

    await writeFile(
      join(installationRoot, 'installation.json'),
      '{"formatVersion":1,"formatVersion":1}\n',
    )
    await expect(readInstallationManifest(
      installationRoot,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'manifest-invalid' })
  })

  it('classifies a missing manifest-selected generation as an invalid manifest', async () => {
    const installationRoot = await root()
    const generationBytes = renderGenerationManifest(INSTALLATION_ID, GENERATION_ID, 3, BUILD_ID)
    const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<typeof renderInstallationManifest>[1]
    await writeFile(
      join(installationRoot, 'installation.json'),
      renderInstallationManifest('ready', generation, generationManifestReference(GENERATION_ID, generationBytes)),
    )
    const manifest = (await readInstallationManifest(
      installationRoot,
      AbortSignal.timeout(2_000),
    ))!.value

    await expect(readSelectedGeneration(
      installationRoot,
      manifest,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'manifest-invalid' })
  })

  it('refuses a generation reached through a Windows junction or POSIX symlink', async () => {
    const installationRoot = await root()
    const external = await root()
    const generationBytes = renderGenerationManifest(INSTALLATION_ID, GENERATION_ID, 3, BUILD_ID)
    const externalGeneration = join(external, GENERATION_ID)
    const valuable = join(external, 'valuable.txt')
    await mkdir(externalGeneration)
    await writeFile(join(externalGeneration, 'generation.json'), generationBytes)
    await writeFile(valuable, 'outside')
    await symlink(external, join(installationRoot, 'generations'), process.platform === 'win32' ? 'junction' : 'dir')
    const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<typeof renderInstallationManifest>[1]
    await writeFile(
      join(installationRoot, 'installation.json'),
      renderInstallationManifest('ready', generation, generationManifestReference(GENERATION_ID, generationBytes)),
    )
    const manifest = (await readInstallationManifest(
      installationRoot,
      AbortSignal.timeout(2_000),
    ))!.value

    try {
      await expect(readSelectedGeneration(
        installationRoot,
        manifest,
        AbortSignal.timeout(2_000),
      )).rejects.toMatchObject({ code: 'recovery-required' })
    } finally {
      await expect(readFile(valuable, 'utf8')).resolves.toBe('outside')
    }
  })

  it('rejects unbounded, non-UTF-8, and field-invalid Installation manifests', async () => {
    const installationRoot = await root()
    const manifestPath = join(installationRoot, 'installation.json')
    await mkdir(manifestPath)
    await expect(readInstallationManifest(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'manifest-invalid' })

    await rm(manifestPath, { recursive: true })
    await writeFile(manifestPath, Buffer.alloc((16 * 1_024) + 1, 0x20))
    await expect(readInstallationManifest(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'manifest-invalid' })

    await writeFile(manifestPath, Buffer.from([0xc3, 0x28]))
    await expect(readInstallationManifest(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'manifest-invalid' })

    await writeFile(manifestPath, '{}\n')
    await expect(readInstallationManifest(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'manifest-invalid' })
  })

  it('requires selected generation metadata to agree with every Installation authority field', async () => {
    const installationRoot = await root()
    const generationBytes = renderGenerationManifest(INSTALLATION_ID, GENERATION_ID, 3, BUILD_ID)
    const generationPath = join(installationRoot, ...generationJsonLeaf(GENERATION_ID).split('/'))
    await mkdir(dirname(generationPath), { recursive: true })
    await writeFile(generationPath, generationBytes)
    const reference = generationManifestReference(GENERATION_ID, generationBytes)
    const base = {
      formatVersion: 1 as const,
      phase: 'ready' as const,
      installationId: INSTALLATION_ID,
      storageGenerationId: GENERATION_ID,
      stateVersion: 3,
      generationJson: reference,
    }

    await expect(readSelectedGeneration(
      installationRoot,
      { ...base, installationId: OTHER_INSTALLATION_ID },
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'manifest-invalid' })
    await expect(readSelectedGeneration(
      installationRoot,
      { ...base, stateVersion: 4 },
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'manifest-invalid' })
  })

  it('preserves a bounded-manifest classification for non-regular required generation metadata', async () => {
    const installationRoot = await root()
    const generationBytes = renderGenerationManifest(INSTALLATION_ID, GENERATION_ID, 3, BUILD_ID)
    const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<typeof renderInstallationManifest>[1]
    const generationPath = join(installationRoot, ...generationJsonLeaf(GENERATION_ID).split('/'))
    await mkdir(generationPath, { recursive: true })
    const manifest = installationManifestSchema.parse(JSON.parse(renderInstallationManifest(
      'ready',
      generation,
      generationManifestReference(GENERATION_ID, generationBytes),
    ).toString('utf8')))

    await expect(readSelectedGeneration(
      installationRoot,
      manifest,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'manifest-invalid' })
  })
})
