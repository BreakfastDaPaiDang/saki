import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  requireOwnedPathAncestors,
  validateOwnedPathAncestors,
} from '../src/owned-path.ts'
import { SakiMaintenanceError } from '../src/error.ts'

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-owned-path-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki Installation-owned path ancestors', () => {
  it('distinguishes complete and missing real-directory chains', async () => {
    const installationRoot = await root()
    const signal = new AbortController().signal
    await mkdir(join(installationRoot, 'nested'))

    await expect(validateOwnedPathAncestors(
      installationRoot,
      join(installationRoot, 'direct.txt'),
      signal,
    )).resolves.toBe(true)
    await expect(validateOwnedPathAncestors(
      installationRoot,
      join(installationRoot, 'nested', 'child.txt'),
      signal,
    )).resolves.toBe(true)
    await expect(validateOwnedPathAncestors(
      installationRoot,
      join(installationRoot, 'missing', 'child.txt'),
      signal,
    )).resolves.toBe(false)
    await expect(requireOwnedPathAncestors(
      installationRoot,
      join(installationRoot, 'missing', 'child.txt'),
      signal,
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('rejects paths outside the Installation root and non-directory ancestors', async () => {
    const installationRoot = await root()
    const signal = new AbortController().signal
    const file = join(installationRoot, 'not-a-directory')
    await writeFile(file, 'file')

    await expect(validateOwnedPathAncestors(
      installationRoot,
      installationRoot,
      signal,
    )).rejects.toMatchObject({ code: 'recovery-required' })
    await expect(validateOwnedPathAncestors(
      installationRoot,
      dirname(installationRoot),
      signal,
    )).rejects.toMatchObject({ code: 'recovery-required' })
    await expect(validateOwnedPathAncestors(
      installationRoot,
      join(dirname(installationRoot), 'outside', 'file.txt'),
      signal,
    )).rejects.toMatchObject({ code: 'recovery-required' })
    await expect(validateOwnedPathAncestors(
      installationRoot,
      join(file, 'child.txt'),
      signal,
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('reports an ancestor that cannot be inspected', async () => {
    const installationRoot = await root()

    const failure = await validateOwnedPathAncestors(
      installationRoot,
      join(installationRoot, 'invalid\0ancestor', 'child.txt'),
      new AbortController().signal,
    ).then(
      () => new Error('invalid ancestor unexpectedly passed validation'),
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(SakiMaintenanceError)
    if (!(failure instanceof SakiMaintenanceError)) throw failure
    expect(failure.code).toBe('recovery-required')
    expect(failure.cause).toBeInstanceOf(TypeError)
  })
})
