import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import {
  createTransportGitDirectory,
  createGitHubPushTransport,
  gitHubPushArguments,
  gitHubRemoteReadArguments,
  type GitHubTransportGit,
  type PushTransportReadRequest,
} from '../src/git-push.ts'
import {
  createOwnedPrivateGitDirectory,
  type OwnedPrivateGitDirectory,
} from '../src/owned-private-git-directory.ts'
import { gitAlternatePath } from '../src/safe-repository.ts'

const SIGNAL = new AbortController().signal
const run = promisify(execFile)
const SHA1 = 'a'.repeat(40)
const SHA256 = 'b'.repeat(64)
const PRIVATE_GIT_DIRECTORY: OwnedPrivateGitDirectory = {
  path: 'private-git',
  async assertIntegrity() {},
  async [Symbol.asyncDispose]() {},
}
const REQUEST: PushTransportReadRequest = {
  repository: { nameWithOwner: 'BreakfastDaPaiDang/saki' },
  targetRef: 'refs/heads/main',
  objectFormat: 'sha1',
  credential: 'git-credential-manager',
  privateGitDirectory: PRIVATE_GIT_DIRECTORY,
}

async function createAlternateBackedDirectory(): Promise<OwnedPrivateGitDirectory> {
  const draft = await createOwnedPrivateGitDirectory('transport')
  const config = Buffer.from('[core]\n\tbare = false\n')
  const alternate = Buffer.from('C:/objects\n')
  try {
    await mkdir(join(draft.path, 'objects', 'info'), { recursive: true })
    await writeFile(join(draft.path, 'config'), config)
    await writeFile(join(draft.path, 'objects', 'info', 'alternates'), alternate)
    return await draft.seal({
      config,
      objectAlternates: { kind: 'exact', bytes: alternate },
    })
  } catch (error) {
    await draft[Symbol.asyncDispose]()
    throw error
  }
}

describe('GitHub Push transport', () => {
  it.each([
    { name: 'absent branch', objectFormat: 'sha1' as const, stdout: Buffer.alloc(0), expected: { kind: 'absent' } },
    {
      name: 'SHA-1 branch',
      objectFormat: 'sha1' as const,
      stdout: Buffer.from(`${SHA1}\trefs/heads/main\n`),
      expected: { kind: 'commit', objectId: SHA1 },
    },
    {
      name: 'SHA-256 branch with CRLF',
      objectFormat: 'sha256' as const,
      stdout: Buffer.from(`${SHA256}\trefs/heads/main\r\n`),
      expected: { kind: 'commit', objectId: SHA256 },
    },
  ])('parses one exact $name observation', async ({ objectFormat, stdout, expected }) => {
    const privateGitDirectory = await createTransportGitDirectory()
    const runGitHubTransport = vi.fn(async () => ({ stdout, stderr: Buffer.alloc(0) }))
    const transport = createGitHubPushTransport({ runGitHubTransport })
    const request = { ...REQUEST, objectFormat, privateGitDirectory }
    try {
      await expect(transport.readBranch(request, SIGNAL)).resolves.toEqual(expected)
      expect(runGitHubTransport).toHaveBeenCalledWith(
        request.privateGitDirectory.path,
        gitHubRemoteReadArguments(request),
        SIGNAL,
        request.credential,
      )
    } finally {
      await privateGitDirectory[Symbol.asyncDispose]()
    }
  })

  it.each([
    { name: 'stderr', stdout: Buffer.alloc(0), stderr: Buffer.from('unexpected') },
    { name: 'wrong ref', stdout: Buffer.from(`${SHA1}\trefs/heads/other\n`), stderr: Buffer.alloc(0) },
    { name: 'wrong object width', stdout: Buffer.from('abc\trefs/heads/main\n'), stderr: Buffer.alloc(0) },
    { name: 'invalid UTF-8', stdout: Buffer.from([0xff]), stderr: Buffer.alloc(0) },
  ])('rejects a malformed $name observation', async ({ stdout, stderr }) => {
    const git: GitHubTransportGit = { runGitHubTransport: vi.fn(async () => ({ stdout, stderr })) }

    await expect(createGitHubPushTransport(git).readBranch(REQUEST, SIGNAL))
      .rejects.toMatchObject({ code: 'stream-failure' })
  })

  it('delegates one exact force-with-lease Push through the trusted adapter', async () => {
    const runGitHubTransport = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
    const transport = createGitHubPushTransport({ runGitHubTransport })
    const request = { ...REQUEST, commitId: SHA1, previous: { kind: 'absent' as const } }

    await transport.pushBranch(request, SIGNAL)

    expect(runGitHubTransport).toHaveBeenCalledWith(
      request.privateGitDirectory.path,
      gitHubPushArguments(request),
      SIGNAL,
      request.credential,
    )
  })

  it('publishes the intended Commit when a same-named historical ref points elsewhere', async () => {
    const source = await mkdtemp(join(tmpdir(), 'saki-push-ref-shadow-source-'))
    const remote = await mkdtemp(join(tmpdir(), 'saki-push-ref-shadow-remote-'))
    const draft = await createOwnedPrivateGitDirectory('transport')
    let directory: OwnedPrivateGitDirectory | undefined
    try {
      await git(source, 'init', '-b', 'main')
      await git(source, 'config', 'user.name', 'Saki Test')
      await git(source, 'config', 'user.email', 'saki@example.invalid')
      await writeFile(join(source, 'tracked.txt'), 'wrong\n')
      await git(source, 'add', '--', 'tracked.txt')
      await git(source, 'commit', '-m', 'wrong')
      const wrongCommit = await gitText(source, 'rev-parse', 'HEAD')
      await writeFile(join(source, 'tracked.txt'), 'intended\n')
      await git(source, 'commit', '-am', 'intended')
      const intendedCommit = await gitText(source, 'rev-parse', 'HEAD')
      await git(remote, 'init', '--bare')

      const config = Buffer.from('[core]\n\trepositoryformatversion = 0\n\tbare = true\n')
      const alternate = Buffer.from(`${gitAlternatePath(join(source, '.git', 'objects'))}\n`)
      await mkdir(join(draft.path, 'objects', 'info'), { recursive: true })
      await mkdir(join(draft.path, 'refs', 'heads'), { recursive: true })
      await writeFile(join(draft.path, 'config'), config)
      await writeFile(join(draft.path, 'HEAD'), 'ref: refs/heads/main\n')
      await writeFile(join(draft.path, 'objects', 'info', 'alternates'), alternate)
      await writeFile(join(draft.path, 'refs', 'heads', intendedCommit), `${wrongCommit}\n`)
      directory = await draft.seal({
        config,
        objectAlternates: { kind: 'exact', bytes: alternate },
      })

      const repositoryUrl = 'https://github.com/BreakfastDaPaiDang/saki.git'
      const runGitHubTransport = vi.fn(async (cwd: string, args: readonly string[]) => {
        await run('git', [
          `--git-dir=${cwd}`,
          ...args.map(arg => arg === repositoryUrl ? remote : arg),
        ], { windowsHide: true })
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      })
      const request = {
        ...REQUEST,
        privateGitDirectory: directory,
        commitId: intendedCommit,
        previous: { kind: 'absent' as const },
      }

      await createGitHubPushTransport({ runGitHubTransport }).pushBranch(request, SIGNAL)

      expect(await gitText(remote, 'rev-parse', '--verify', 'refs/heads/main')).toBe(intendedCommit)
      expect(runGitHubTransport.mock.calls[0]?.[1]).toContain(
        `${intendedCommit}^{commit}:refs/heads/main`,
      )
    } finally {
      await (directory ?? draft)[Symbol.asyncDispose]()
      // Windows can keep these fixture directories busy briefly after Git exits.
      await Promise.all([
        rm(source, { recursive: true, force: true, maxRetries: 10 }),
        rm(remote, { recursive: true, force: true, maxRetries: 10 }),
      ])
    }
  }, 30_000)

  it('does not invoke the credentialed runner after the private Git config changes', async () => {
    const directory = await createTransportGitDirectory()
    const runGitHubTransport = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
    try {
      await writeFile(join(directory.path, 'config'), '[core]\n\tbare = false\n')

      await expect(createGitHubPushTransport({ runGitHubTransport }).readBranch({
        ...REQUEST,
        privateGitDirectory: directory,
      }, SIGNAL)).rejects.toThrow()
      expect(runGitHubTransport).not.toHaveBeenCalled()
    } finally {
      await directory[Symbol.asyncDispose]()
    }
  })

  it('does not invoke the credentialed runner after the private Git config is replaced', async () => {
    const directory = await createTransportGitDirectory()
    const configPath = join(directory.path, 'config')
    const runGitHubTransport = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
    try {
      const bytes = await readFile(configPath)
      await rename(configPath, join(directory.path, 'retained-config'))
      await writeFile(configPath, bytes)

      await expect(createGitHubPushTransport({ runGitHubTransport }).readBranch({
        ...REQUEST,
        privateGitDirectory: directory,
      }, SIGNAL)).rejects.toThrow()
      expect(runGitHubTransport).not.toHaveBeenCalled()
    } finally {
      await directory[Symbol.asyncDispose]()
    }
  })

  it('does not invoke the credentialed runner after a worktree config appears', async () => {
    const directory = await createTransportGitDirectory()
    const runGitHubTransport = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
    try {
      await writeFile(join(directory.path, 'config.worktree'), '[credential]\n\thelper = unexpected\n')

      await expect(createGitHubPushTransport({ runGitHubTransport }).readBranch({
        ...REQUEST,
        privateGitDirectory: directory,
      }, SIGNAL)).rejects.toThrow()
      expect(runGitHubTransport).not.toHaveBeenCalled()
    } finally {
      await directory[Symbol.asyncDispose]()
    }
  })

  it('does not invoke the credentialed runner after a common-directory redirect appears', async () => {
    const directory = await createTransportGitDirectory()
    const runGitHubTransport = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
    try {
      await writeFile(join(directory.path, 'commondir'), '../other.git\n')

      await expect(createGitHubPushTransport({ runGitHubTransport }).readBranch({
        ...REQUEST,
        privateGitDirectory: directory,
      }, SIGNAL)).rejects.toThrow()
      expect(runGitHubTransport).not.toHaveBeenCalled()
    } finally {
      await directory[Symbol.asyncDispose]()
    }
  })

  it('does not invoke the credentialed runner after an unsealed object alternate appears', async () => {
    const directory = await createTransportGitDirectory()
    const runGitHubTransport = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
    try {
      await writeFile(join(directory.path, 'objects', 'info', 'alternates'), 'unexpected\n')

      await expect(createGitHubPushTransport({ runGitHubTransport }).readBranch({
        ...REQUEST,
        privateGitDirectory: directory,
      }, SIGNAL)).rejects.toThrow()
      expect(runGitHubTransport).not.toHaveBeenCalled()
    } finally {
      await directory[Symbol.asyncDispose]()
    }
  })

  it('does not invoke the credentialed Push runner after the sealed object alternate changes', async () => {
    const directory = await createAlternateBackedDirectory()
    const runGitHubTransport = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
    try {
      await writeFile(join(directory.path, 'objects', 'info', 'alternates'), 'D:/other-objects\n')

      await expect(createGitHubPushTransport({ runGitHubTransport }).pushBranch({
        ...REQUEST,
        privateGitDirectory: directory,
        commitId: SHA1,
        previous: { kind: 'absent' },
      }, SIGNAL)).rejects.toThrow()
      expect(runGitHubTransport).not.toHaveBeenCalled()
    } finally {
      await directory[Symbol.asyncDispose]()
    }
  })

  it('does not invoke the credentialed runner after the sealed object alternate is replaced', async () => {
    const directory = await createAlternateBackedDirectory()
    const alternatesPath = join(directory.path, 'objects', 'info', 'alternates')
    const runGitHubTransport = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
    try {
      const bytes = await readFile(alternatesPath)
      await rename(alternatesPath, join(directory.path, 'retained-alternates'))
      await writeFile(alternatesPath, bytes)

      await expect(createGitHubPushTransport({ runGitHubTransport }).readBranch({
        ...REQUEST,
        privateGitDirectory: directory,
      }, SIGNAL)).rejects.toThrow()
      expect(runGitHubTransport).not.toHaveBeenCalled()
    } finally {
      await directory[Symbol.asyncDispose]()
    }
  })

  it('does not invoke the credentialed runner after the private Git root is replaced', async () => {
    const directory = await createTransportGitDirectory()
    const retainedPath = `${directory.path}-retained`
    const runGitHubTransport = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
    try {
      await rename(directory.path, retainedPath)
      await mkdir(directory.path)

      await expect(createGitHubPushTransport({ runGitHubTransport }).readBranch({
        ...REQUEST,
        privateGitDirectory: directory,
      }, SIGNAL)).rejects.toThrow()
      expect(runGitHubTransport).not.toHaveBeenCalled()
      await expect(directory[Symbol.asyncDispose]()).rejects.toThrow('ownership changed')
    } finally {
      await Promise.all([
        rm(directory.path, { recursive: true, force: true }),
        rm(retainedPath, { recursive: true, force: true }),
      ])
    }
  })

  it('does not seal an unexpected private Git config into credentialed authority', async () => {
    const draft = await createOwnedPrivateGitDirectory('transport')
    const expectedConfig = Buffer.from('[core]\n\tbare = true\n')
    const runGitHubTransport = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
    try {
      await mkdir(join(draft.path, 'objects', 'info'), { recursive: true })
      await writeFile(join(draft.path, 'config'), '[core]\n\tbare = false\n')

      await expect((async () => {
        const directory = await draft.seal({
          config: expectedConfig,
          objectAlternates: { kind: 'absent' },
        })
        return await createGitHubPushTransport({ runGitHubTransport }).readBranch({
          ...REQUEST,
          privateGitDirectory: directory,
        }, SIGNAL)
      })()).rejects.toThrow()
      expect(runGitHubTransport).not.toHaveBeenCalled()
    } finally {
      await draft[Symbol.asyncDispose]()
    }
  })

  it('does not seal an unexpected object alternate into credentialed authority', async () => {
    const draft = await createOwnedPrivateGitDirectory('transport')
    const config = Buffer.from('[core]\n\tbare = true\n')
    const expectedAlternate = Buffer.from('C:/expected-objects\n')
    const runGitHubTransport = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }))
    try {
      await mkdir(join(draft.path, 'objects', 'info'), { recursive: true })
      await writeFile(join(draft.path, 'config'), config)
      await writeFile(join(draft.path, 'objects', 'info', 'alternates'), 'C:/other-objects\n')

      await expect((async () => {
        const directory = await draft.seal({
          config,
          objectAlternates: { kind: 'exact', bytes: expectedAlternate },
        })
        return await createGitHubPushTransport({ runGitHubTransport }).readBranch({
          ...REQUEST,
          privateGitDirectory: directory,
        }, SIGNAL)
      })()).rejects.toThrow()
      expect(runGitHubTransport).not.toHaveBeenCalled()
    } finally {
      await draft[Symbol.asyncDispose]()
    }
  })

  it('unlinks a directory link while removing a private transport tree', async () => {
    const linkedTarget = await mkdtemp(join(tmpdir(), 'saki-push-linked-target-'))
    const sentinel = join(linkedTarget, 'sentinel.txt')
    await writeFile(sentinel, 'keep\n')
    const directory = await createTransportGitDirectory()
    try {
      const linkPath = join(directory.path, 'refs', 'heads')
      await rmdir(linkPath)
      await symlink(linkedTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

      await directory[Symbol.asyncDispose]()

      await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep\n')
    } finally {
      await Promise.all([
        rm(directory.path, { recursive: true, force: true }),
        rm(linkedTarget, { recursive: true, force: true }),
      ])
    }
  })
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', args, { cwd, windowsHide: true })
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
  return stdout.trim()
}
