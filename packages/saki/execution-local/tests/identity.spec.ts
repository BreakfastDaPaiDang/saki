import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLocalAdministrativeDirectoryIdentity } from '../src/identity.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

describe('local Git administrative-directory identity', () => {
  it('rejects an administrative identity target that is not a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-admin-identity-file-'))
    roots.push(root)
    const admin = join(root, '.git')
    await writeFile(admin, 'gitdir: elsewhere\n')

    await expect(readLocalAdministrativeDirectoryIdentity(
      admin,
      new AbortController().signal,
    )).rejects.toThrow('Git administrative identity target is not a directory')
  })

  it('survives child updates but changes when the directory object is replaced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-admin-identity-'))
    roots.push(root)
    const admin = join(root, '.git')
    const prior = join(root, '.git-prior')
    await mkdir(admin)
    const signal = new AbortController().signal

    const initial = await readLocalAdministrativeDirectoryIdentity(admin, signal)
    await writeFile(join(admin, 'config'), '[core]\n')
    expect(await readLocalAdministrativeDirectoryIdentity(admin, signal)).toEqual(initial)

    await rename(admin, prior)
    await mkdir(admin)
    expect(await readLocalAdministrativeDirectoryIdentity(admin, signal)).not.toEqual(initial)
  })
})
