import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'

type FailureMode =
  | 'normal'
  | 'open-race'
  | 'growth'
  | 'read-race'
  | 'read-non-error'
  | 'close-failure'
  | 'read-and-close-failure'

const controls = vi.hoisted(() => ({
  mode: 'normal' as FailureMode,
  ownership: [] as boolean[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  type Handle = Awaited<ReturnType<typeof original.open>>
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
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args)
      let statCalls = 0
      const stat = async (...statArgs: Parameters<Handle['stat']>) => {
        statCalls += 1
        const value = await handle.stat(...statArgs)
        if (controls.mode === 'open-race' && statCalls === 1) return shifted(value)
        if (controls.mode === 'read-race' && statCalls === 2) return shifted(value)
        return value
      }
      const read = controls.mode === 'growth'
        ? async (): Promise<{ bytesRead: number; buffer: Buffer }> => ({
          bytesRead: (16 * 1_024) + 1,
          buffer: Buffer.alloc(0),
        })
        : controls.mode === 'read-non-error'
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- fault injection proves unknown rejection normalization.
          ? async (): Promise<never> => await Promise.reject({ kind: 'read-failure' })
          : controls.mode === 'read-and-close-failure'
            ? async (): Promise<never> => await Promise.reject(new Error('manifest read failed'))
            : handle.read.bind(handle)
      const close = async (): Promise<void> => {
        await handle.close()
        if (controls.mode === 'close-failure' || controls.mode === 'read-and-close-failure') {
          throw new Error('manifest close failed')
        }
      }
      return {
        stat,
        read,
        close,
      } as unknown as Handle
    },
  }
})

vi.mock('../src/owned-path.ts', () => ({
  validateOwnedPathAncestors: vi.fn(async () => controls.ownership.shift() ?? true),
}))

import {
  generationJsonLeaf,
  generationManifestReference,
  installationManifestSchema,
  readInstallationManifest,
  readSelectedGeneration,
  readUnselectedGeneration,
  renderGenerationManifest,
  renderInstallationManifest,
} from '../src/manifest.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const BUILD_ID = 'saki-build-test' as SakiBuildId
const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-manifest-io-'))
  roots.push(value)
  return value
}

function setMode(mode: FailureMode): void {
  controls.mode = mode
  controls.ownership.length = 0
}

async function writeValid(installationRoot: string): Promise<{
  generationBytes: Buffer
  manifest: ReturnType<typeof installationManifestSchema.parse>
}> {
  const generationBytes = renderGenerationManifest(INSTALLATION_ID, GENERATION_ID, 3, BUILD_ID)
  const generationPath = join(installationRoot, ...generationJsonLeaf(GENERATION_ID).split('/'))
  await mkdir(dirname(generationPath), { recursive: true })
  await writeFile(generationPath, generationBytes)
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<typeof renderInstallationManifest>[1]
  const installationBytes = renderInstallationManifest(
    'ready',
    generation,
    generationManifestReference(GENERATION_ID, generationBytes),
  )
  await writeFile(join(installationRoot, 'installation.json'), installationBytes)
  return {
    generationBytes,
    manifest: installationManifestSchema.parse(JSON.parse(installationBytes.toString('utf8'))),
  }
}

afterEach(async () => {
  setMode('normal')
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki manifest bounded-read failures', () => {
  it.each([
    ['open-race', 'changed while opening'],
    ['growth', 'exceeds its byte limit'],
    ['read-race', 'changed while reading'],
  ] as const)('rejects a manifest that %s', async (mode, message) => {
    const installationRoot = await root()
    await writeValid(installationRoot)
    setMode(mode)

    await expect(readInstallationManifest(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toThrow(message)
  })

  it('normalizes a non-Error read failure and preserves a close failure', async () => {
    const installationRoot = await root()
    await writeValid(installationRoot)

    setMode('read-non-error')
    const readFailure = await readInstallationManifest(
      installationRoot,
      AbortSignal.timeout(2_000),
    ).then(() => undefined, (error: unknown) => error)
    expect(readFailure).toBeInstanceOf(Error)
    expect((readFailure as Error).cause).toEqual({ kind: 'read-failure' })

    setMode('close-failure')
    await expect(readInstallationManifest(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toThrow('manifest close failed')
  })

  it('reports a read failure together with a close failure', async () => {
    const installationRoot = await root()
    await writeValid(installationRoot)
    setMode('read-and-close-failure')

    const failure = await readInstallationManifest(
      installationRoot,
      AbortSignal.timeout(2_000),
    ).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
  })
})

describe('Saki manifest ancestor revalidation', () => {
  it('rejects a selected or unselected generation whose owned ancestor disappears after reading', async () => {
    const installationRoot = await root()
    const { manifest } = await writeValid(installationRoot)

    controls.ownership.push(true, false)
    await expect(readSelectedGeneration(
      installationRoot,
      manifest,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'manifest-invalid' })

    controls.ownership.push(true, false)
    await expect(readUnselectedGeneration(
      installationRoot,
      INSTALLATION_ID,
      GENERATION_ID,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'manifest-invalid' })
  })

  it('preserves cancellation while opening required generation metadata', async () => {
    const installationRoot = await root()
    const { manifest } = await writeValid(installationRoot)
    const controller = new AbortController()
    controller.abort(new Error('cancel generation read'))
    controls.ownership.push(true)

    await expect(readSelectedGeneration(installationRoot, manifest, controller.signal))
      .rejects.toThrow('cancel generation read')
  })
})
