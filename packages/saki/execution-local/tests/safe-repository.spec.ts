import { execFile } from 'node:child_process'
import { lstat as nativeLstat, mkdir, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, normalize, relative } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  canonicalDigest,
  MAX_GIT_REF_CHARS,
  type SakiHostId,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/index.ts'
import { GitCommandError, GitRunner } from '../src/git-runner.ts'
import { inspectLocalProjectSelection } from '../src/inspection.ts'
import {
  gitAlternatePath,
  isSafeLocalRepositoryPath,
  openSafeRepositoryView,
  RepositoryControlChangedError,
} from '../src/safe-repository.ts'

const run = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
const MAX_CONTROL_FILE_BYTES = 1024 * 1024
const CONFIG: Omit<Required<Config>, 'pushCredentialHelper'> = {
  gitCommandTimeoutMs: 10_000,
  gitTerminationGraceMs: 100,
  maxGitStdoutBytes: 1024 * 1024,
  maxGitStderrBytes: 64 * 1024,
  inventoryMaxEntries: 10_000,
  inventoryMaxPathBytes: 1024 * 1024,
  inventoryMaxGitOutputBytes: 4 * 1024 * 1024,
  inventoryMaxFileBytes: MAX_CONTROL_FILE_BYTES,
  inventoryMaxTotalFileBytes: 8 * 1024 * 1024,
  inventoryMaxCaptureMs: 10_000,
  baselineMaxEntries: 1_000,
  baselineMaxPathBytes: 1024 * 1024,
  baselineMaxGitOutputBytes: 4 * 1024 * 1024,
  baselineMaxFileBytes: 1024 * 1024,
  baselineMaxTotalFileBytes: 4 * 1024 * 1024,
  baselineMaxCaptureMs: 10_000,
  operationMaxIndexBytes: 8 * 1024 * 1024,
  operationMaxReflogBytes: 1024 * 1024,
}

async function deterministicAdministrativeDirectoryIdentity(
  path: string,
  signal: AbortSignal,
): Promise<{ readonly version: 1; readonly digest: string }> {
  signal.throwIfAborted()
  return {
    version: 1,
    digest: canonicalDigest('saki/test-administrative-directory-identity/v1', { path: normalize(path) }),
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(async (context) => { await context.fiber.dispose() }))
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }))
})

function fixtureGitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  )
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    LANG: 'C',
  }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=',
    ...args,
  ], { cwd, env: fixtureGitEnvironment(), windowsHide: true })
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=',
    ...args,
  ], { cwd, env: fixtureGitEnvironment(), windowsHide: true })).stdout.trim()
}

async function repository(options: {
  readonly refFormat?: 'reftable'
  readonly unborn?: boolean
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-safe-repository-'))
  roots.push(root)
  await git(root, 'init', '--initial-branch=main',
    ...(options.refFormat === undefined ? [] : [`--ref-format=${options.refFormat}`]))
  await git(root, 'config', 'user.name', 'Saki Test')
  await git(root, 'config', 'user.email', 'saki@example.invalid')
  await git(root, 'config', 'core.autocrlf', 'false')
  if (options.unborn !== true) {
    await writeFile(join(root, 'tracked.txt'), 'initial\n')
    await git(root, 'add', 'tracked.txt')
    await git(root, 'commit', '-m', 'initial')
  }
  return root
}

async function localHarness(cwd = process.cwd()): Promise<{ readonly fs: FileSystem; readonly git: GitRunner }> {
  const context = new Context()
  contexts.push(context)
  await context.plugin(LocalFileSystem, { cwd })
  await context.plugin(LocalSubprocessRuntime)
  const executable = await context.subprocess.resolveExecutable('git')
  return {
    fs: context.fs,
    git: new GitRunner(context.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    }),
  }
}

function withLstatHook(
  fs: FileSystem,
  path: string,
  occurrence: number,
  phase: 'before' | 'after',
  hook: () => Promise<void>,
): FileSystem {
  let matches = 0
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === 'lstat') {
        return async (
          candidate: string,
          options?: Parameters<FileSystem['lstat']>[1],
          signal?: AbortSignal,
        ) => {
          const selected = normalize(candidate) === normalize(path) && ++matches === occurrence
          if (selected && phase === 'before') await hook()
          const result = await target.lstat(candidate, options, signal)
          if (selected && phase === 'after') await hook()
          return result
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      const method = value as (...args: readonly unknown[]) => unknown
      return method.bind(target)
    },
  })
}

function withResolveHook(
  fs: FileSystem,
  path: string,
  occurrence: number,
  hook: () => Promise<void>,
): FileSystem {
  let matches = 0
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === 'resolve') {
        return async (
          candidate: string,
          options?: Parameters<FileSystem['resolve']>[1],
        ) => {
          const result = await target.resolve(candidate, options)
          if (normalize(candidate) === normalize(path) && ++matches === occurrence) await hook()
          return result
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      const method = value as (...args: readonly unknown[]) => unknown
      return method.bind(target)
    },
  })
}

function withReadBytesHook(
  fs: FileSystem,
  path: string,
  occurrence: number,
  hook: () => Promise<void>,
): FileSystem {
  let matches = 0
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === 'readBytes') {
        return async (...args: Parameters<FileSystem['readBytes']>) => {
          const result = await target.readBytes(...args)
          if (normalize(target.processPath(args[0])) === normalize(path) && ++matches === occurrence) {
            await hook()
          }
          return result
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      const method = value as (...args: readonly unknown[]) => unknown
      return method.bind(target)
    },
  })
}

function withCanonicalPaths(
  fs: FileSystem,
  paths: readonly ((actual: string) => string)[],
): FileSystem {
  let index = 0
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === 'processPath') {
        return (candidate: Parameters<FileSystem['processPath']>[0]) => {
          const actual = target.processPath(candidate)
          return (paths[index++] ?? ((value: string) => value))(actual)
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      const method = value as (...args: readonly unknown[]) => unknown
      return method.bind(target)
    },
  })
}

function withoutLstatSize(fs: FileSystem, path: string): FileSystem {
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === 'lstat') {
        return async (...args: Parameters<FileSystem['lstat']>) => {
          const result = await target.lstat(...args)
          return normalize(args[0]) === normalize(path) && result !== undefined
            ? { type: result.type, version: result.version }
            : result
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      const method = value as (...args: readonly unknown[]) => unknown
      return method.bind(target)
    },
  })
}

describe('safe repository admission', () => {
  it('validates POSIX and Windows local path spellings without filesystem access', () => {
    expect(isSafeLocalRepositoryPath('/srv/repository', 'linux')).toBe(true)
    expect(isSafeLocalRepositoryPath('\\\\server\\share\\repository', 'linux')).toBe(true)
    expect(isSafeLocalRepositoryPath('/srv/repository\nsecret', 'linux')).toBe(false)
    expect(gitAlternatePath('/srv/repository/.git/objects', 'linux'))
      .toBe('/srv/repository/.git/objects')
    expect(gitAlternatePath('C:\\repository\\.git\\objects', 'win32'))
      .toBe('C:/repository/.git/objects')

    for (const path of ['C:\\safe\\repository', 'relative\\repository', 'C:\\safe\\repository\\']) {
      expect(isSafeLocalRepositoryPath(path, 'win32'), path).toBe(true)
    }
    for (const path of [
      '\\\\server\\share\\repository',
      '\\??\\C:\\repository',
      'C:relative\\repository',
      'C:\\safe\\repository:secret',
      'C:\\safe\\NUL\\repository',
      'C:\\safe\\CONIN$\\repository',
      'C:\\safe\\COM²\\repository',
      'C:\\safe\\repository. ',
      'C:\\safe\\parent\\..\\repository',
    ]) expect(isSafeLocalRepositoryPath(path, 'win32'), path).toBe(false)
  })

  it('exposes only the closed repository query allowlist', async () => {
    const root = await repository()
    const harness = await localHarness()
    const signal = new AbortController().signal
    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      signal,
    )
    expect(opened.kind).toBe('repository')
    if (opened.kind !== 'repository') return
    await using view = opened.view

    const autocrlf = await view.git.run(root, [
      'config', '--no-includes', '--null', '--get-all', 'core.autocrlf',
    ], signal)
    expect(autocrlf.stdout).toEqual(Buffer.from('false\0'))

    const worktreeList = [
      '--bare', `--git-dir=${view.commonDirectoryPath}`, 'worktree', 'list', '--porcelain', '-z',
    ] as const
    await expect(view.git.run(root, worktreeList, signal)).rejects.toThrow(/malformed/u)

    await expect(view.git.run(root, ['rev-parse', '--is-bare-repository'], signal))
      .resolves.toMatchObject({ stdout: Buffer.from('false\n') })
    await expect(view.git.run(root, ['rev-parse', '--path-format=absolute', '--show-toplevel'], signal))
      .resolves.toMatchObject({ stdout: Buffer.from(`${view.topLevelPath}\n`) })
    await expect(view.git.run(root, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'], signal))
      .resolves.toMatchObject({ stdout: Buffer.from(`${view.gitDirectoryPath}\n`) })
    await expect(view.git.run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal))
      .resolves.toMatchObject({ stdout: Buffer.from(`${view.commonDirectoryPath}\n`) })

    const emptyInput = { bytes: Buffer.alloc(0), maxBytes: 1 }
    for (const [args, stdin] of [
      [['check-attr', '--all', '-z', '--stdin'], emptyInput],
      [['ls-tree', '-r', '--full-tree', '-z', 'HEAD'], undefined],
      [['ls-files', '--no-sparse', '-t', '--stage', '--full-name', '-z'], undefined],
      [['ls-files', '-v', '-z', '--'], undefined],
      [['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], undefined],
      [['rev-parse', '--show-object-format'], undefined],
      [['rev-parse', '--verify', 'HEAD'], undefined],
      [['rev-parse', '--verify', 'HEAD^{commit}'], undefined],
      [[
        'merge-base', '--is-ancestor', `${'a'.repeat(40)}^{commit}`, `${'b'.repeat(40)}^{commit}`,
      ], undefined],
      [['symbolic-ref', '--quiet', 'HEAD'], undefined],
      [['config', '--no-includes', '--null', '--name-only', '--list'], undefined],
      [['config', '--no-includes', '--local', '--null', '--name-only', '--list'], undefined],
      [['config', '--no-includes', '--worktree', '--null', '--name-only', '--list'], undefined],
      [['config', '--no-includes', '--null', '--get-regexp', '^remote\\..*\\.url$'], undefined],
      [[
        'for-each-ref',
        '--count=2',
        '--format=%(refname)%00%(upstream)%00%(upstream:short)%00',
        'refs/heads/main',
      ], undefined],
      [['config', '--no-includes', '--null', '--type=bool', '--get-all', 'core.autocrlf'], undefined],
      [['config', '--no-includes', '--null', '--type=bool', '--get-all', 'core.fileMode'], undefined],
      [['config', '--no-includes', '--null', '--type=bool', '--get-all', 'core.symlinks'], undefined],
      [['config', '--no-includes', '--local', '--null', '--type=bool', '--get-all', 'core.fsmonitor'], undefined],
      [['config', '--no-includes', '--local', '--null', '--type=bool', '--get-all', 'extensions.worktreeConfig'], undefined],
      [['config', '--no-includes', '--worktree', '--null', '--type=bool', '--get-all', 'core.fsmonitor'], undefined],
      [['config', '--no-includes', '--worktree', '--null', '--type=bool', '--get-all', 'extensions.worktreeConfig'], undefined],
    ] as const) {
      try {
        await view.git.run(root, args, signal, stdin)
      } catch (error) {
        expect(error, args.join(' ')).toBeInstanceOf(GitCommandError)
      }
    }

    for (const [args, stdin] of [
      [['check-attr', '--all', '-z', '--stdin'], undefined],
      [['rev-parse', '--show-object-format'], emptyInput],
      [['merge-base', '--is-ancestor', 'a'.repeat(40), 'b'.repeat(40)], undefined],
      [['symbolic-ref', 'HEAD', 'refs/heads/unsafe'], undefined],
      [['config', '--no-includes', '--null', '--get-all', 'core.hooksPath'], undefined],
      [[
        'for-each-ref',
        '--count=2',
        '--format=%(refname)%00%(upstream)%00%(upstream:short)%00',
        'refs/tags/main',
      ], undefined],
    ] as const) {
      await expect(view.git.run(root, args, signal, stdin)).rejects.toThrow(/unavailable/u)
    }

    await view.git.run(root, ['rev-parse', '--verify', 'HEAD'], signal)
    await expect(view.git.run(root, worktreeList, signal)).resolves.toMatchObject({ stderr: Buffer.alloc(0) })
  })

  it.each([
    ['config changes', async (path: string) => {
      await writeFile(join(path, 'config'), '[core]\n\tbare = true\n')
    }],
    ['common-directory redirect appears', async (path: string) => {
      await writeFile(join(path, 'commondir'), '../other.git\n')
    }],
    ['graft ancestry override appears', async (path: string) => {
      await mkdir(join(path, 'info'), { recursive: true })
      await writeFile(join(path, 'info', 'grafts'), `${'a'.repeat(40)} ${'b'.repeat(40)}\n`)
    }],
  ])('does not invoke the read-only runner after its private Git %s', async (_name, mutate) => {
    const root = await repository()
    const harness = await localHarness()
    const signal = new AbortController().signal
    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      signal,
    )
    expect(opened.kind).toBe('repository')
    if (opened.kind !== 'repository') return
    await using view = opened.view
    const rawRun = vi.spyOn(harness.git, 'run').mockResolvedValue({
      stdout: Buffer.from('sha1\n'),
      stderr: Buffer.alloc(0),
    })
    await mutate(view.privateGitDirectory.path)

    await expect(view.git.run(root, [
      'merge-base', '--is-ancestor', `${'a'.repeat(40)}^{commit}`, `${'b'.repeat(40)}^{commit}`,
    ], signal)).rejects.toThrow()
    expect(rawRun).not.toHaveBeenCalled()
  })

  it.each(['core.sparseCheckout', 'index.sparse'])(
    'retains the effective %s fact without exposing the source config to repository queries',
    async (key) => {
      const root = await repository()
      await git(root, 'config', key, 'true')
      const harness = await localHarness()
      const opened = await openSafeRepositoryView(
        harness.fs,
        harness.git,
        await realpath(root),
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )

      expect(opened.kind).toBe('repository')
      if (opened.kind !== 'repository') return
      await using view = opened.view
      expect(view.sparseIndexEnabled).toBe(true)
    },
  )

  it('uses common config when enabled linked-worktree config is absent', async () => {
    const root = await repository()
    const linked = `${root}-linked`
    roots.push(linked)
    await git(root, 'worktree', 'add', '--detach', linked)
    await git(root, 'config', 'extensions.worktreeConfig', 'true')
    const linkedGitDirectory = await gitText(linked, 'rev-parse', '--absolute-git-dir')
    await expect(run('git', [
      '-c', 'core.autocrlf=false',
      'config', '--file', join(linkedGitDirectory, 'config.worktree'), '--list',
    ], { cwd: linked, env: fixtureGitEnvironment(), windowsHide: true })).rejects.toMatchObject({ code: 128 })
    expect(await gitText(linked, 'rev-parse', '--is-bare-repository')).toBe('false')

    const harness = await localHarness()
    const signal = new AbortController().signal
    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(linked),
      MAX_CONTROL_FILE_BYTES,
      signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind !== 'repository') return
    await using view = opened.view
    await expect(view.git.run(linked, ['rev-parse', '--verify', 'HEAD'], signal)).resolves.toMatchObject({
      stderr: Buffer.alloc(0),
    })
    await expect(view.assertSourceControlUnchanged(signal)).resolves.toBeUndefined()
  }, 15_000)

  it('rejects an explicitly empty worktree-specific core.worktree', async () => {
    const root = await repository()
    const linked = `${root}-linked-empty-worktree`
    roots.push(linked)
    await git(root, 'worktree', 'add', '--detach', linked)
    await git(root, 'config', 'extensions.worktreeConfig', 'true')
    await git(linked, 'config', '--worktree', 'core.worktree', '')
    const harness = await localHarness()

    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(linked),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(opened.kind).toBe('malformed')
  }, 15_000)

  it('admits the explicit files ref backend', async () => {
    const root = await repository()
    await git(root, 'config', 'core.repositoryFormatVersion', '1')
    await git(root, 'config', 'extensions.refStorage', 'files')
    const harness = await localHarness()

    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
  })

  it('rejects split-index repositories before exposing repository queries', async () => {
    const root = await repository()
    await git(root, 'update-index', '--split-index')
    const harness = await localHarness()

    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(opened.kind).toBe('unavailable')
  })

  it('rejects a non-empty shared-index path reported by the private repository', async () => {
    const root = await repository()
    const harness = await localHarness()
    let queried = false
    const splitIndex = {
      run: async (...args: Parameters<GitRunner['run']>) => {
        if (args[1].includes('--shared-index-path')) {
          queried = true
          return { stdout: Buffer.from('sharedindex.test\n'), stderr: Buffer.alloc(0) }
        }
        return await harness.git.run(...args)
      },
    } as GitRunner

    const opened = await openSafeRepositoryView(
      harness.fs,
      splitIndex,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(queried).toBe(true)
    expect(opened.kind).toBe('unavailable')
  })

  it.each([
    ['sha1', 40],
    ['sha256', 64],
  ] as const)('records the %s zero object id after an unborn HEAD query fails', async (objectFormat, width) => {
    const root = await repository({ unborn: true })
    if (objectFormat === 'sha256') {
      await git(root, 'config', 'core.repositoryFormatVersion', '1')
      await git(root, 'config', 'extensions.objectFormat', 'sha256')
    }
    const harness = await localHarness()
    const signal = new AbortController().signal
    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind !== 'repository') return
    await using view = opened.view
    await expect(view.git.run(root, ['rev-parse', '--verify', 'HEAD'], signal))
      .rejects.toMatchObject({ code: 'nonzero', exitCode: 128 })
    await expect(view.git.run(root, [
      '--bare', `--git-dir=${view.commonDirectoryPath}`, 'worktree', 'list', '--porcelain', '-z',
    ], signal)).resolves.toEqual({
      stdout: Buffer.from([
        `worktree ${view.topLevelPath}\0`,
        `HEAD ${'0'.repeat(width)}\0`,
        'branch refs/heads/main\0',
        '\0',
      ].join('')),
      stderr: Buffer.alloc(0),
    })
  })

  it('classifies a reftable repository as unavailable without weakening the snapshot', async () => {
    const root = await repository({ refFormat: 'reftable' })
    const harness = await localHarness()

    const result = await inspectLocalProjectSelection(
      harness.fs,
      { list: () => [] },
      harness.git,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
      deterministicAdministrativeDirectoryIdentity,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  }, 15_000)

  it('rejects malformed source control files by their closed category', async () => {
    const harness = await localHarness()
    const cases: readonly {
      readonly name: string
      readonly expected: 'malformed' | 'unavailable'
      readonly mutate: (root: string) => Promise<void>
    }[] = [
      {
        name: 'missing config',
        expected: 'malformed',
        mutate: async (root) => { await rm(join(root, '.git', 'config')) },
      },
      {
        name: 'empty common worktree',
        expected: 'malformed',
        mutate: async (root) => { await git(root, 'config', 'core.worktree', '') },
      },
      {
        name: 'unknown object format',
        expected: 'malformed',
        mutate: async (root) => {
          await git(root, 'config', 'core.repositoryFormatVersion', '1')
          await git(root, 'config', 'extensions.objectFormat', 'sha512')
        },
      },
      {
        name: 'non-UTF-8 HEAD',
        expected: 'malformed',
        mutate: async (root) => { await writeFile(join(root, '.git', 'HEAD'), Buffer.from([0xff, 0x0a])) },
      },
      {
        name: 'multiline HEAD',
        expected: 'malformed',
        mutate: async (root) => { await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\nsecond\n') },
      },
      {
        name: 'unsafe branch HEAD',
        expected: 'malformed',
        mutate: async (root) => { await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/bad.lock\n') },
      },
      {
        name: 'malformed gitfile prefix',
        expected: 'malformed',
        mutate: async (root) => {
          await rm(join(root, '.git'), { recursive: true })
          await writeFile(join(root, '.git'), 'not-a-gitfile\n')
        },
      },
      {
        name: 'multiline gitfile',
        expected: 'malformed',
        mutate: async (root) => {
          await rm(join(root, '.git'), { recursive: true })
          await writeFile(join(root, '.git'), 'gitdir: elsewhere\nsecond\n')
        },
      },
      {
        name: 'gitfile without newline',
        expected: 'malformed',
        mutate: async (root) => {
          await rm(join(root, '.git'), { recursive: true })
          await writeFile(join(root, '.git'), 'gitdir: elsewhere')
        },
      },
      {
        name: 'overlong resolved gitfile target',
        expected: 'unavailable',
        mutate: async (root) => {
          await rm(join(root, '.git'), { recursive: true })
          await writeFile(join(root, '.git'), `gitdir: ${'directory/'.repeat(4_000)}target\n`)
        },
      },
    ]

    for (const testCase of cases) {
      const root = await repository()
      await testCase.mutate(root)
      const opened = await openSafeRepositoryView(
        harness.fs,
        harness.git,
        await realpath(root),
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
      expect(opened.kind, testCase.name).toBe(testCase.expected)
    }
  }, 20_000)

  it('accepts CRLF control lines and a detached HEAD', async () => {
    const root = await repository()
    const originalGitDirectory = join(root, '.git')
    const separateGitDirectory = join(root, '.git-separate')
    await git(root, 'checkout', '--detach')
    const detachedHead = await gitText(root, 'rev-parse', 'HEAD')
    await writeFile(join(originalGitDirectory, 'HEAD'), `${detachedHead}\r\n`)
    await rename(originalGitDirectory, separateGitDirectory)
    await writeFile(originalGitDirectory, `gitdir: ${separateGitDirectory.replaceAll('\\', '/')}\r\n`)
    const harness = await localHarness()

    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind !== 'repository') return
    await using view = opened.view
    await view.git.run(root, ['rev-parse', '--verify', 'HEAD'], new AbortController().signal)
  })

  it('admits absent optional index and loose-ref files', async () => {
    const harness = await localHarness()

    const withoutIndex = await repository()
    await rm(join(withoutIndex, '.git', 'index'))
    const indexOpened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(withoutIndex),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )
    expect(indexOpened.kind).toBe('repository')
    if (indexOpened.kind === 'repository') await indexOpened.view[Symbol.asyncDispose]()

    const packedOnly = await repository()
    await git(packedOnly, 'pack-refs', '--all', '--prune')
    const packedOpened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(packedOnly),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )
    expect(packedOpened.kind).toBe('repository')
    if (packedOpened.kind === 'repository') await packedOpened.view[Symbol.asyncDispose]()
  })

  it('pins a configured upstream without copying the current branch as its own loose ref', async () => {
    const root = await repository()
    const harness = await localHarness()
    const branch = 'refs/heads/main'
    const selfUpstream = {
      run: async (...args: Parameters<GitRunner['run']>) => args[1].includes('for-each-ref')
        ? {
          stdout: Buffer.from(`${branch}\0${branch}\0main\0\n`),
          stderr: Buffer.alloc(0),
        }
        : await harness.git.run(...args),
    } as GitRunner

    const opened = await openSafeRepositoryView(
      harness.fs,
      selfUpstream,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
  })

  it('rejects malformed or overlong configured upstream evidence', async () => {
    const root = await repository()
    const canonicalRoot = await realpath(root)
    const harness = await localHarness()
    const branch = 'refs/heads/main'
    for (const testCase of [
      {
        name: 'overlong upstream ref',
        stdout: `${branch}\0refs/remotes/origin/${'a'.repeat(MAX_GIT_REF_CHARS)}\0origin/main\0\n`,
        expected: 'unavailable',
      },
      {
        name: 'overlong upstream short name',
        stdout: `${branch}\0refs/remotes/origin/main\0origin/${'a'.repeat(MAX_GIT_REF_CHARS)}\0\n`,
        expected: 'unavailable',
      },
      {
        name: 'upstream without a full ref',
        stdout: `${branch}\0origin/main\0origin/main\0\n`,
        expected: 'malformed',
      },
      {
        name: 'invalid full upstream ref',
        stdout: `${branch}\0refs/remotes/origin/bad.lock\0origin/bad.lock\0\n`,
        expected: 'malformed',
      },
      {
        name: 'control character in upstream short name',
        stdout: `${branch}\0refs/remotes/origin/main\0origin/\tmain\0\n`,
        expected: 'malformed',
      },
      {
        name: 'mismatched branch frame',
        stdout: 'refs/heads/other\0refs/remotes/origin/main\0origin/main\0\n',
        expected: 'malformed',
      },
      {
        name: 'incomplete frame',
        stdout: `${branch}\0refs/remotes/origin/main\0origin/main\0`,
        expected: 'malformed',
      },
      {
        name: 'upstream ref without a short name',
        stdout: `${branch}\0refs/remotes/origin/main\0\0\n`,
        expected: 'malformed',
      },
    ] as const) {
      const injected = {
        run: async (...args: Parameters<GitRunner['run']>) => args[1].includes('for-each-ref')
          ? { stdout: Buffer.from(testCase.stdout), stderr: Buffer.alloc(0) }
          : await harness.git.run(...args),
      } as GitRunner

      const opened = await openSafeRepositoryView(
        harness.fs,
        injected,
        canonicalRoot,
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )

      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
      expect(opened.kind, testCase.name).toBe(testCase.expected)
    }
  }, 30_000)

  it('rejects Windows-unsafe upstream paths before probing their loose refs', async () => {
    const root = await repository()
    const canonicalRoot = await realpath(root)
    const harness = await localHarness()
    const branch = 'refs/heads/main'
    const upstream = 'refs/remotes/NUL/main'
    let looseRefProbes = 0
    const unsafeUpstream = {
      run: async (...args: Parameters<GitRunner['run']>) => args[1].includes('for-each-ref')
        ? {
          stdout: Buffer.from(`${branch}\0${upstream}\0NUL/main\0\n`),
          stderr: Buffer.alloc(0),
        }
        : await harness.git.run(...args),
    } as GitRunner
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    const opened = await openSafeRepositoryView(
      withLstatHook(
        harness.fs,
        join(canonicalRoot, '.git', ...upstream.split('/')),
        1,
        'before',
        async () => { looseRefProbes += 1 },
      ),
      unsafeUpstream,
      canonicalRoot,
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(opened.kind).toBe('unavailable')
    expect(looseRefProbes).toBe(0)
  })

  it('rejects a configured upstream with a malformed loose object id', async () => {
    const root = await repository()
    const canonicalRoot = await realpath(root)
    const harness = await localHarness()
    const branch = 'refs/heads/main'
    const upstream = 'refs/remotes/origin/main'
    const looseRef = join(canonicalRoot, '.git', ...upstream.split('/'))
    await mkdir(dirname(looseRef), { recursive: true })
    await writeFile(looseRef, 'not-an-object-id\n')
    const malformedUpstream = {
      run: async (...args: Parameters<GitRunner['run']>) => args[1].includes('for-each-ref')
        ? {
          stdout: Buffer.from(`${branch}\0${upstream}\0origin/main\0\n`),
          stderr: Buffer.alloc(0),
        }
        : await harness.git.run(...args),
    } as GitRunner

    const opened = await openSafeRepositoryView(
      harness.fs,
      malformedUpstream,
      canonicalRoot,
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(opened.kind).toBe('unavailable')
  })

  it('copies a configured upstream with a valid loose object id', async () => {
    const root = await repository()
    const canonicalRoot = await realpath(root)
    const harness = await localHarness()
    const branch = 'refs/heads/main'
    const upstream = 'refs/remotes/origin/main'
    const looseRef = join(canonicalRoot, '.git', ...upstream.split('/'))
    await mkdir(dirname(looseRef), { recursive: true })
    await writeFile(looseRef, `${await gitText(root, 'rev-parse', 'HEAD')}\n`)
    const configuredUpstream = {
      run: async (...args: Parameters<GitRunner['run']>) => args[1].includes('for-each-ref')
        ? {
          stdout: Buffer.from(`${branch}\0${upstream}\0origin/main\0\n`),
          stderr: Buffer.alloc(0),
        }
        : await harness.git.run(...args),
    } as GitRunner

    const opened = await openSafeRepositoryView(
      harness.fs,
      configuredUpstream,
      canonicalRoot,
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
  })

  it('backdates the private index before repository-aware Git reads it', async () => {
    const root = await repository()
    const canonicalRoot = await realpath(root)
    const sourceIndex = await nativeLstat(join(canonicalRoot, '.git', 'index'), { bigint: true })
    const harness = await localHarness()
    let privateIndexMtimeNs: bigint | undefined
    const observingGit = {
      run: async (...args: Parameters<GitRunner['run']>) => {
        const [cwd, gitArgs] = args
        if (privateIndexMtimeNs === undefined && gitArgs[0] === `--git-dir=${cwd}`) {
          privateIndexMtimeNs = (await nativeLstat(join(cwd, 'index'), { bigint: true })).mtimeNs
        }
        return await harness.git.run(...args)
      },
    } as GitRunner

    const opened = await openSafeRepositoryView(
      harness.fs,
      observingGit,
      canonicalRoot,
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(privateIndexMtimeNs).toBeDefined()
    expect(privateIndexMtimeNs as bigint).toBeLessThan(sourceIndex.mtimeNs)
  })

  it('rejects an index changed after its native timestamp capture', async () => {
    const root = await repository()
    const canonicalRoot = await realpath(root)
    const index = join(canonicalRoot, '.git', 'index')
    const harness = await localHarness()
    const opened = await openSafeRepositoryView(
      withLstatHook(harness.fs, index, 3, 'before', async () => {
        await writeFile(index, 'raced index control file')
      }),
      harness.git,
      canonicalRoot,
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(opened.kind).toBe('unavailable')
  })

  it('clamps a private index timestamp at the Unix epoch', async () => {
    const root = await repository()
    const canonicalRoot = await realpath(root)
    await utimes(join(canonicalRoot, '.git', 'index'), 0.5, 0.5)
    const harness = await localHarness()

    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      canonicalRoot,
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
  })

  it('rejects a HEAD without its required line ending', async () => {
    const root = await repository()
    const head = await gitText(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, '.git', 'HEAD'), head)
    const harness = await localHarness()

    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(opened.kind).toBe('malformed')
  })

  it('rejects Windows-unsafe branch paths before probing a loose ref', async () => {
    const harness = await localHarness()
    const fixtures = await Promise.all([
      'refs/heads/NUL',
      'refs/heads/foo./bar',
    ].map(async (branch) => {
      const root = await repository()
      const canonical = await realpath(root)
      await writeFile(join(canonical, '.git', 'HEAD'), `ref: ${branch}\n`)
      return { branch, canonical }
    }))
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    for (const { branch, canonical } of fixtures) {
      const sourceRef = join(canonical, '.git', ...branch.split('/'))
      let looseRefProbes = 0
      const opened = await openSafeRepositoryView(
        withLstatHook(harness.fs, sourceRef, 1, 'before', async () => { looseRefProbes += 1 }),
        harness.git,
        canonical,
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
      expect(opened.kind, branch).toBe('unavailable')
      expect(looseRefProbes, branch).toBe(0)
    }
  })

  it('rejects an ordinary repository with a commondir control entry before Git', async () => {
    const root = await repository()
    await writeFile(join(root, '.git', 'commondir'), '.\n')
    const harness = await localHarness()
    let gitRuns = 0
    const forbiddenGit = {
      run: async () => {
        gitRuns += 1
        throw new Error('ordinary commondir reached Git')
      },
    } as unknown as GitRunner

    const opened = await openSafeRepositoryView(
      harness.fs,
      forbiddenGit,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(opened.kind).toBe('unavailable')
    expect(gitRuns).toBe(0)
  })

  it('rejects a non-canonical selected directory before reading repository config', async () => {
    const root = await repository()
    const harness = await localHarness(dirname(root))
    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      basename(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(opened.kind).toBe('malformed')
  })

  it('rejects a Windows network gitfile spelling before probing its target', async () => {
    const root = await repository()
    await rm(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git'), 'gitdir: \\\\offline.invalid\\share\\repository\n')
    const harness = await localHarness()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    let gitRuns = 0
    const recording = {
      run: async (...args: Parameters<GitRunner['run']>) => {
        gitRuns += 1
        return await harness.git.run(...args)
      },
    } as GitRunner

    const opened = await openSafeRepositoryView(
      harness.fs,
      recording,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(opened.kind).toBe('unavailable')
    expect(gitRuns).toBe(0)
  })

  it('rejects unsafe or changing canonical directory spellings before Git', async () => {
    const harness = await localHarness()
    const identity = (value: string): string => value
    for (const [name, paths, expected] of [
      ['first relative', [() => 'relative-canonical'], 'unavailable'],
      ['first multiline', [(actual: string) => `${actual}\nsecond`], 'unavailable'],
      ['first overlong', [(actual: string) => `${actual}${'x'.repeat(40_000)}`], 'unavailable'],
      ['second relative', [identity, () => 'relative-canonical'], 'unavailable'],
      ['second multiline', [identity, (actual: string) => `${actual}\rsecond`], 'unavailable'],
      ['second overlong', [identity, (actual: string) => `${actual}${'x'.repeat(40_000)}`], 'unavailable'],
      ['second changed', [identity, (actual: string) => `${actual}-changed`], 'malformed'],
    ] as const) {
      const root = await repository()
      let gitRuns = 0
      const forbiddenGit = {
        run: async () => {
          gitRuns += 1
          throw new Error('unsafe canonical path reached Git')
        },
      } as unknown as GitRunner
      const opened = await openSafeRepositoryView(
        withCanonicalPaths(harness.fs, paths),
        forbiddenGit,
        await realpath(root),
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
      expect(opened.kind, name).toBe(expected)
      expect(gitRuns, name).toBe(0)
    }
  }, 20_000)

  it('detects repository-directory replacement during stable resolution', async () => {
    const harness = await localHarness()
    const openWithoutGit = async (
      root: string,
      fs: FileSystem,
      expected: 'malformed' | 'unavailable',
      name: string,
    ): Promise<void> => {
      let gitRuns = 0
      const forbiddenGit = {
        run: async () => {
          gitRuns += 1
          throw new Error('directory race reached Git')
        },
      } as unknown as GitRunner
      const opened = await openSafeRepositoryView(
        fs,
        forbiddenGit,
        await realpath(root).catch(() => root),
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
      expect(opened.kind, name).toBe(expected)
      expect(gitRuns, name).toBe(0)
    }

    {
      const root = await repository()
      const canonical = await realpath(root)
      await openWithoutGit(
        canonical,
        withLstatHook(harness.fs, join(canonical, '.git'), 1, 'after', async () => {
          await rm(canonical, { recursive: true })
        }),
        'malformed',
        'top-level removal',
      )
    }

    {
      const root = await repository()
      const canonical = await realpath(root)
      const gitDirectory = join(canonical, '.git')
      await openWithoutGit(
        canonical,
        withLstatHook(harness.fs, gitDirectory, 1, 'after', async () => {
          await rm(gitDirectory, { recursive: true })
        }),
        'malformed',
        'ordinary Git directory removal',
      )
    }

    {
      const root = await mkdtemp(join(tmpdir(), 'saki-safe-separate-race-'))
      const gitDirectory = `${root}-git`
      const movedGitDirectory = `${gitDirectory}-moved`
      roots.push(root, gitDirectory, movedGitDirectory)
      await git(root, 'init', '--initial-branch=main', `--separate-git-dir=${gitDirectory}`)
      await openWithoutGit(
        root,
        withLstatHook(harness.fs, gitDirectory, 1, 'after', async () => {
          await rename(gitDirectory, movedGitDirectory)
        }),
        'malformed',
        'gitfile target replacement',
      )
    }

    for (const [name, fsFor, expected] of [
      ['first target changed to file', (fs: FileSystem, objects: string) => withResolveHook(
        fs,
        objects,
        1,
        async () => {
          await rename(objects, `${objects}-before-race`)
          await writeFile(objects, 'not a directory')
        },
      ), 'malformed'],
      ['confirmed target missing', (fs: FileSystem, objects: string) => withLstatHook(
        fs,
        objects,
        3,
        'before',
        async () => { await rm(objects, { recursive: true }) },
      ), 'malformed'],
      ['confirmed target version changed', (fs: FileSystem, objects: string) => withLstatHook(
        fs,
        objects,
        3,
        'before',
        async () => { await writeFile(join(objects, 'race-marker'), 'changed') },
      ), 'malformed'],
      ['second target changed to file', (fs: FileSystem, objects: string) => withResolveHook(
        fs,
        objects,
        2,
        async () => {
          await rename(objects, `${objects}-before-second-race`)
          await writeFile(objects, 'not a directory')
        },
      ), 'malformed'],
    ] as const) {
      const root = await repository()
      const canonical = await realpath(root)
      const objects = join(canonical, '.git', 'objects')
      const opened = await openSafeRepositoryView(
        fsFor(harness.fs, objects),
        harness.git,
        canonical,
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
      expect(opened.kind, name).toBe(expected)
    }
  }, 30_000)

  it('detects control-file replacement throughout a stable read', async () => {
    const harness = await localHarness()
    const openWithoutGit = async (
      root: string,
      fs: FileSystem,
      maxBytes: number,
      name: string,
    ): Promise<void> => {
      let gitRuns = 0
      const forbiddenGit = {
        run: async () => {
          gitRuns += 1
          throw new Error('control-file race reached Git')
        },
      } as unknown as GitRunner
      const opened = await openSafeRepositoryView(
        fs,
        forbiddenGit,
        await realpath(root),
        maxBytes,
        new AbortController().signal,
      )
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
      expect(opened.kind, name).toBe('unavailable')
      expect(gitRuns, name).toBe(0)
    }

    {
      const root = await repository()
      await openWithoutGit(root, harness.fs, 1, 'oversized source entry')
    }

    {
      const root = await repository()
      const config = join(await realpath(root), '.git', 'config')
      await rm(config)
      await mkdir(config)
      await openWithoutGit(root, harness.fs, MAX_CONTROL_FILE_BYTES, 'directory source entry')
    }

    {
      const root = await repository()
      const config = join(await realpath(root), '.git', 'config')
      await openWithoutGit(
        root,
        withResolveHook(harness.fs, config, 1, async () => {
          await rename(config, `${config}-before-race`)
          await mkdir(config)
        }),
        MAX_CONTROL_FILE_BYTES,
        'target changed to directory',
      )
    }

    {
      const root = await repository()
      const config = join(await realpath(root), '.git', 'config')
      await writeFile(config, '[core]\n\tbare = false\n')
      await openWithoutGit(
        root,
        withResolveHook(harness.fs, config, 1, async () => {
          await writeFile(config, 'x'.repeat(64))
        }),
        32,
        'target grew past the byte limit',
      )
    }

    for (const [name, mutate] of [
      ['confirmed source missing', async (config: string) => { await rm(config) }],
      ['confirmed source changed to directory', async (config: string) => {
        await rm(config)
        await mkdir(config)
      }],
      ['confirmed source version changed', async (config: string) => {
        await writeFile(config, '[core]\n\tbare = true\n')
      }],
    ] as const) {
      const root = await repository()
      const config = join(await realpath(root), '.git', 'config')
      await openWithoutGit(
        root,
        withReadBytesHook(harness.fs, config, 1, async () => { await mutate(config) }),
        MAX_CONTROL_FILE_BYTES,
        name,
      )
    }
  }, 30_000)

  it('contains malformed Git output while parsing private control files', async () => {
    const root = await repository()
    const harness = await localHarness()
    const cases: readonly {
      readonly name: string
      readonly intercept: (args: readonly string[]) => Buffer | undefined
    }[] = [
      {
        name: 'non-UTF-8 config name',
        intercept: args => args[0] === 'config' && args.includes('--file')
          && args.includes('--name-only') ? Buffer.from([0xff, 0]) : undefined,
      },
      {
        name: 'unterminated config name list',
        intercept: args => args[0] === 'config' && args.includes('--file')
          && args.includes('--name-only') ? Buffer.from('core.bare') : undefined,
      },
      {
        name: 'invalid converted boolean',
        intercept: args => args[0] === 'config' && args.includes('--file')
          && args.includes('--type=bool') && args.at(-1) === 'core.bare'
          ? Buffer.from('invalid\0') : undefined,
      },
    ]

    for (const testCase of cases) {
      const injected = {
        run: async (
          cwd: string,
          args: readonly string[],
          signal: AbortSignal,
          stdin?: Parameters<GitRunner['run']>[3],
          outputBudget?: Parameters<GitRunner['run']>[4],
        ) => {
          const stdout = testCase.intercept(args)
          return stdout === undefined
            ? await harness.git.run(cwd, args, signal, stdin, outputBudget)
            : { stdout, stderr: Buffer.alloc(0) }
        },
      } as GitRunner
      const opened = await openSafeRepositoryView(
        harness.fs,
        injected,
        await realpath(root),
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
      expect(opened.kind, testCase.name).toBe('malformed')
    }

    const emptyNameList = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => args[0] === 'config' && args.includes('--file') && args.includes('--name-only')
        ? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
        : await harness.git.run(cwd, args, signal, stdin, outputBudget),
    } as GitRunner
    const emptyNameOpened = await openSafeRepositoryView(
      harness.fs,
      emptyNameList,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )
    expect(emptyNameOpened.kind).toBe('repository')
    if (emptyNameOpened.kind === 'repository') await emptyNameOpened.view[Symbol.asyncDispose]()

    const malformedHead = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => args.some(argument => argument.startsWith('--git-dir='))
        && args[0]?.startsWith('--git-dir=')
        && args.at(-1) === 'HEAD'
        ? { stdout: Buffer.from('head-without-newline'), stderr: Buffer.alloc(0) }
        : await harness.git.run(cwd, args, signal, stdin, outputBudget),
    } as GitRunner
    const opened = await openSafeRepositoryView(
      harness.fs,
      malformedHead,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )
    expect(opened.kind).toBe('repository')
    if (opened.kind !== 'repository') return
    await using view = opened.view
    await expect(view.git.run(root, ['rev-parse', '--verify', 'HEAD'], new AbortController().signal))
      .rejects.toThrow(/malformed/u)

    const head = await gitText(root, 'rev-parse', 'HEAD')
    const crlfHead = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => args[0]?.startsWith('--git-dir=') && args.at(-1) === 'HEAD'
        ? { stdout: Buffer.from(`${head}\r\n`), stderr: Buffer.alloc(0) }
        : await harness.git.run(cwd, args, signal, stdin, outputBudget),
    } as GitRunner
    const crlfOpened = await openSafeRepositoryView(
      harness.fs,
      crlfHead,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )
    expect(crlfOpened.kind).toBe('repository')
    if (crlfOpened.kind !== 'repository') return
    await using crlfView = crlfOpened.view
    await crlfView.git.run(root, ['rev-parse', '--verify', 'HEAD'], new AbortController().signal)
  })

  it('contains malformed or unrepresentable private config list records', async () => {
    const root = await repository()
    const harness = await localHarness()
    for (const testCase of [
      {
        name: 'record without a name-value separator',
        stdout: Buffer.from('core.bare\0'),
        expected: 'malformed',
      },
      {
        name: 'control character in an ignored config name',
        stdout: Buffer.from('ignored.\u0001name\nvalue\0'),
        expected: 'repository',
      },
      {
        name: 'control character in a retained config value',
        stdout: Buffer.from('remote.origin.fetch\nbad\u000bvalue\0'),
        expected: 'unavailable',
      },
    ] as const) {
      const injected = {
        run: async (...args: Parameters<GitRunner['run']>) => {
          const gitArgs = args[1]
          if (gitArgs[0] === 'config' && gitArgs.includes('--file') && gitArgs.includes('--list')) {
            return { stdout: testCase.stdout, stderr: Buffer.alloc(0) }
          }
          return await harness.git.run(...args)
        },
      } as GitRunner
      const opened = await openSafeRepositoryView(
        harness.fs,
        injected,
        await realpath(root),
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )

      expect(opened.kind, testCase.name).toBe(testCase.expected)
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    }
  })

  it('omits repository identity fields from worktree-scoped private config', async () => {
    const root = await repository()
    await git(root, 'config', 'extensions.worktreeConfig', 'true')
    await git(root, 'config', '--worktree', 'core.fileMode', 'true')
    const harness = await localHarness()
    const injected = {
      run: async (...args: Parameters<GitRunner['run']>) => {
        const gitArgs = args[1]
        const fileIndex = gitArgs.indexOf('--file')
        if (gitArgs[0] === 'config' && gitArgs.includes('--list') && fileIndex >= 0
          && gitArgs[fileIndex + 1]?.endsWith('source.config.worktree') === true) {
          return {
            stdout: Buffer.from([
              'core.repositoryFormatVersion\n1\0',
              'extensions.objectFormat\nsha256\0',
              'extensions.refStorage\nfiles\0',
            ].join('')),
            stderr: Buffer.alloc(0),
          }
        }
        return await harness.git.run(...args)
      },
    } as GitRunner

    const opened = await openSafeRepositoryView(
      harness.fs,
      injected,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
  })

  it('rejects diagnostics from successful private config parsing commands', async () => {
    const root = await repository()
    const harness = await localHarness()
    const selectors = [
      (args: readonly string[]) => args[0] === 'config' && args.includes('--file') && args.includes('--name-only'),
      (args: readonly string[]) => args[0] === 'config' && args.includes('--file') && args.includes('--get-all'),
      (args: readonly string[]) => args[0] === 'config' && args.includes('--file') && args.includes('--get-regexp'),
      (args: readonly string[]) => args[0] === 'config' && args.includes('--file')
        && args.includes('--list') && !args.includes('--name-only'),
      (args: readonly string[]) => args[0]?.startsWith('--git-dir=') === true
        && args.includes('--shared-index-path'),
      (args: readonly string[]) => args[0]?.startsWith('--git-dir=') === true
        && args.includes('for-each-ref'),
    ]

    for (const selects of selectors) {
      let injected = false
      const diagnostic = {
        run: async (
          cwd: string,
          args: readonly string[],
          signal: AbortSignal,
          stdin?: Parameters<GitRunner['run']>[3],
          outputBudget?: Parameters<GitRunner['run']>[4],
        ) => {
          if (!injected && selects(args)) {
            injected = true
            return { stdout: Buffer.alloc(0), stderr: Buffer.from('private config diagnostic') }
          }
          return await harness.git.run(cwd, args, signal, stdin, outputBudget)
        },
      } as GitRunner

      const opened = await openSafeRepositoryView(
        harness.fs,
        diagnostic,
        await realpath(root),
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )

      expect(injected).toBe(true)
      expect(opened.kind).toBe('unavailable')
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    }
  }, 30_000)

  it('rejects missing or link-shaped object storage before repository queries', async () => {
    const harness = await localHarness()
    for (const [name, mutate, expected] of [
      ['missing', async (objects: string) => { await rm(objects, { recursive: true }) }, 'malformed'],
      ['symlink', async (objects: string) => {
        const source = `${objects}-source`
        await rename(objects, source)
        await symlink(source, objects, process.platform === 'win32' ? 'junction' : 'dir')
      }, 'unavailable'],
    ] as const) {
      const root = await repository()
      const canonicalRoot = await realpath(root)
      const objects = join(canonicalRoot, '.git', 'objects')
      await mutate(objects)
      const opened = await openSafeRepositoryView(
        harness.fs,
        harness.git,
        canonicalRoot,
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
      expect(opened.kind, name).toBe(expected)
    }
  })

  it('classifies missing and reparse-configured worktrees without following them', async () => {
    const harness = await localHarness()
    for (const [name, configure, expected] of [
      ['missing', async (root: string) => { await git(root, 'config', 'core.worktree', join(root, 'missing')) }, 'malformed'],
      ['reparse', async (root: string) => {
        const alias = `${root}-worktree-alias`
        roots.push(alias)
        await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
        await git(root, 'config', 'core.worktree', alias)
      }, 'unavailable'],
    ] as const) {
      const root = await repository()
      await configure(root)
      const opened = await openSafeRepositoryView(
        harness.fs,
        harness.git,
        await realpath(root),
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
      expect(opened.kind, name).toBe(expected)
    }
  })

  it('reports a malformed confirmation as a control-file change', async () => {
    const root = await repository()
    const harness = await localHarness()
    const signal = new AbortController().signal
    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(root),
      MAX_CONTROL_FILE_BYTES,
      signal,
    )
    expect(opened.kind).toBe('repository')
    if (opened.kind !== 'repository') return
    await using view = opened.view
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/bad.lock\n')

    await expect(view.assertSourceControlUnchanged(signal))
      .rejects.toBeInstanceOf(RepositoryControlChangedError)
  })

  it('rejects empty or reparse linked common-directory controls', async () => {
    const harness = await localHarness()
    for (const [name, mutate, expected] of [
      ['empty', async (_root: string, admin: string) => {
        await writeFile(join(admin, 'commondir'), '\n')
      }, 'malformed'],
      ['reparse', async (root: string, admin: string) => {
        const alias = `${root}-common-alias`
        roots.push(alias)
        await symlink(join(root, '.git'), alias, process.platform === 'win32' ? 'junction' : 'dir')
        await writeFile(join(admin, 'commondir'), `${alias.replaceAll('\\', '/')}\n`)
      }, 'unavailable'],
    ] as const) {
      const root = await repository()
      const linked = `${root}-linked-common-${name}`
      roots.push(linked)
      await git(root, 'worktree', 'add', '--detach', linked)
      const admin = await gitText(linked, 'rev-parse', '--absolute-git-dir')
      await mutate(root, admin)
      const opened = await openSafeRepositoryView(
        harness.fs,
        harness.git,
        await realpath(linked),
        MAX_CONTROL_FILE_BYTES,
        new AbortController().signal,
      )
      if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
      expect(opened.kind, name).toBe(expected)
    }
  }, 20_000)

  it('accepts a locked entry from a provider that omits optional size metadata', async () => {
    const root = await repository()
    const linked = `${root}-linked-locked-no-size`
    roots.push(linked)
    await git(root, 'worktree', 'add', '--detach', linked)
    await git(root, 'worktree', 'lock', linked)
    const admin = await gitText(linked, 'rev-parse', '--absolute-git-dir')
    const harness = await localHarness()

    const opened = await openSafeRepositoryView(
      withoutLstatSize(harness.fs, join(admin, 'locked')),
      harness.git,
      await realpath(linked),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind !== 'repository') return
    await using view = opened.view
    expect(view.locked).toBe(true)
  }, 15_000)

  it('distinguishes malformed linked topology from an existing mismatched backlink', async () => {
    const harness = await localHarness()

    const malformedRoot = await repository()
    const malformedLinked = `${malformedRoot}-linked`
    roots.push(malformedLinked)
    await git(malformedRoot, 'worktree', 'add', '--detach', malformedLinked)
    const malformedAdmin = await gitText(malformedLinked, 'rev-parse', '--absolute-git-dir')
    const unrelated = await repository()
    await writeFile(
      join(malformedAdmin, 'commondir'),
      `${relative(malformedAdmin, join(unrelated, '.git')).replaceAll('\\', '/')}\n`,
    )
    const malformed = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(malformedLinked),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )
    if (malformed.kind === 'repository') await malformed.view[Symbol.asyncDispose]()
    expect(malformed.kind).toBe('malformed')

    const ambiguousRoot = await repository()
    const ambiguousLinked = `${ambiguousRoot}-linked`
    roots.push(ambiguousLinked)
    await git(ambiguousRoot, 'worktree', 'add', '--detach', ambiguousLinked)
    const ambiguousAdmin = await gitText(ambiguousLinked, 'rev-parse', '--absolute-git-dir')
    await writeFile(join(ambiguousAdmin, 'gitdir'), `${join(unrelated, '.git').replaceAll('\\', '/')}\n`)
    const ambiguous = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(ambiguousLinked),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )
    if (ambiguous.kind === 'repository') await ambiguous.view[Symbol.asyncDispose]()
    expect(ambiguous.kind).toBe('ambiguous')

    const prunableRoot = await repository()
    const prunableLinked = `${prunableRoot}-linked`
    roots.push(prunableLinked)
    await git(prunableRoot, 'worktree', 'add', '--detach', prunableLinked)
    const prunableAdmin = await gitText(prunableLinked, 'rev-parse', '--absolute-git-dir')
    await writeFile(join(prunableAdmin, 'gitdir'), `${prunableLinked}-missing/.git\n`)
    const prunable = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(prunableLinked),
      MAX_CONTROL_FILE_BYTES,
      new AbortController().signal,
    )
    if (prunable.kind === 'repository') await prunable.view[Symbol.asyncDispose]()
    expect(prunable.kind).toBe('prunable')
  }, 20_000)
})
