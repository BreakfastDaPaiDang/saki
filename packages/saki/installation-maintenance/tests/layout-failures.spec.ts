import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const filesystem = vi.hoisted(() => ({
  readdir: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readdir: filesystem.readdir }
})

import { selectSakiInstallationSource } from '../src/layout.ts'

const roots: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki Installation source inspection failures', () => {
  it('propagates a root-directory read failure that is not absence', async () => {
    const installationRoot = await mkdtemp(join(tmpdir(), 'saki-layout-failure-'))
    roots.push(installationRoot)
    const failure = Object.assign(new Error('root cannot be read'), { code: 'EACCES' })
    filesystem.readdir.mockRejectedValueOnce(failure)

    await expect(selectSakiInstallationSource(
      installationRoot,
      join(installationRoot, 'control.sqlite'),
      AbortSignal.timeout(2_000),
    )).rejects.toBe(failure)
  })
})
