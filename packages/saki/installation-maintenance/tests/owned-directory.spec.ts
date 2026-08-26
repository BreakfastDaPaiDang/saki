import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeOwnedDirectory } from '../src/owned-directory.ts'

async function createTemporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

describe('journal-owned directory removal', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true })
    }))
  })

  it('removes a real owned directory recursively', async () => {
    const root = await createTemporaryDirectory('saki-owned-directory-')
    roots.push(root)
    const owned = join(root, 'owned')
    await mkdir(owned)
    await writeFile(join(owned, 'state.sqlite'), 'state')

    removeOwnedDirectory(owned, new AbortController().signal)

    await expect(lstat(owned)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('unlinks a directory link without traversing its target', async () => {
    const root = await createTemporaryDirectory('saki-owned-directory-')
    roots.push(root)
    const target = join(root, 'outside')
    const owned = join(root, 'owned')
    await mkdir(target)
    await writeFile(join(target, 'keep.txt'), 'keep')
    await symlink(target, owned, process.platform === 'win32' ? 'junction' : 'dir')

    removeOwnedDirectory(owned, new AbortController().signal)

    await expect(lstat(owned)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('refuses an unexpected regular file and observes prior cancellation', async () => {
    const root = await createTemporaryDirectory('saki-owned-directory-')
    roots.push(root)
    const owned = join(root, 'owned')
    await writeFile(owned, 'not a directory')
    expect(() => {
      removeOwnedDirectory(owned, new AbortController().signal)
    }).toThrow(
      /unexpected filesystem entry/u,
    )
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    expect(() => {
      removeOwnedDirectory(owned, controller.signal)
    }).toThrow('stop')
    await expect(readFile(owned, 'utf8')).resolves.toBe('not a directory')
  })

  it('propagates a filesystem failure that is not a missing entry', () => {
    expect(() => {
      removeOwnedDirectory('\0', new AbortController().signal)
    }).toThrow()
  })

  it('treats an already-missing owned directory as settled', async () => {
    const root = await createTemporaryDirectory('saki-owned-directory-')
    roots.push(root)
    const missing = join(root, 'missing')
    expect(() => {
      removeOwnedDirectory(missing, new AbortController().signal)
    }).not.toThrow()
  })
})
