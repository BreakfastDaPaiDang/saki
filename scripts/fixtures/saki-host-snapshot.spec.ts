import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { sakiSnapshotEnvironment } from '../saki-snapshot-environment.ts'
import { createRepository, inspectSnapshotRepositoryGitState } from './saki-host-snapshot.ts'

const run = promisify(execFile)

it('inspects staged content without refreshing an index with uncached file metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saki-snapshot-inspection-'))
  try {
    const repository = await createRepository(root)
    await writeFile(join(repository, 'tracked.txt'), 'staged\n')
    const git = async (...args: string[]) => await run('git', [
      '--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args,
    ], {
      cwd: repository, windowsHide: true, timeout: 20_000,
      env: { ...sakiSnapshotEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    })
    const blob = await git('hash-object', '-w', '--no-filters', '--', 'tracked.txt')
    await git('update-index', '--cacheinfo', '100644', blob.stdout.trim(), 'tracked.txt')
    const index = join(repository, '.git', 'index')
    const bytes = await readFile(index)
    const modified = (await stat(index, { bigint: true })).mtimeNs

    const observed = await inspectSnapshotRepositoryGitState(repository)

    expect(observed).toMatchObject({ commitCount: 1, stagedPaths: ['tracked.txt'], unstagedPaths: [] })
    expect(await readFile(index)).toEqual(bytes)
    expect((await stat(index, { bigint: true })).mtimeNs).toBe(modified)

    await writeFile(join(repository, 'tracked.txt'), 'unstaged\n')
    expect(await inspectSnapshotRepositoryGitState(repository))
      .toMatchObject({ stagedPaths: ['tracked.txt'], unstagedPaths: ['tracked.txt'] })
    expect(await readFile(index)).toEqual(bytes)
    expect((await stat(index, { bigint: true })).mtimeNs).toBe(modified)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
