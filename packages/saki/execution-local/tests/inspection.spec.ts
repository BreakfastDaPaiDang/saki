import { execFile } from 'node:child_process'
import { constants as bufferConstants } from 'node:buffer'
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, normalize, parse, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  FsError,
  FsTargetKey,
  FsVersion,
  type FileSystem,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
} from '@deepseek-ai/dsh-fs'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  canonicalDigest,
  MAX_INHERITED_BASELINE_ENTRIES,
  MAX_GIT_REF_CHARS,
  MAX_INVENTORY_ENTRIES,
  MAX_SAFE_REMOTES,
  MAX_TRUSTED_PATH_CHARS,
  type SakiHostId,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertSupportedGitVersion,
  LocalSakiHostExecution,
  MIN_OPERATION_MAX_INDEX_BYTES,
  sanitizeRemote,
  type Config,
} from '../src/index.ts'
import { GitCommandError, GitRunner, gitInspectionEnvironment } from '../src/git-runner.ts'
import {
  inspectLocalProjectSelection as inspectSelection,
  inspectRemotes,
  inspectStableLocalProjectSelection,
  parseObservedUpstream,
  projectDisplayLocation,
  projectSelectionRejectionReason,
  worktreeHeadMatches,
  type AdministrativeDirectoryIdentityReader,
} from '../src/inspection.ts'
import { openSafeRepositoryView } from '../src/safe-repository.ts'
import { mountLocalHostOperationStorage } from './storage.ts'

const run = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
const CONFIG: Omit<Required<Config>, 'pushCredentialHelper'> = {
  gitCommandTimeoutMs: 10_000,
  gitTerminationGraceMs: 100,
  maxGitStdoutBytes: 1024 * 1024,
  maxGitStderrBytes: 64 * 1024,
  inventoryMaxEntries: 10_000,
  inventoryMaxPathBytes: 1024 * 1024,
  inventoryMaxGitOutputBytes: 4 * 1024 * 1024,
  inventoryMaxFileBytes: 1024 * 1024,
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

const deterministicAdministrativeDirectoryIdentity: AdministrativeDirectoryIdentityReader = async (path, signal) => {
  signal.throwIfAborted()
  return {
    version: 1,
    digest: canonicalDigest('saki/test-administrative-directory-identity/v1', { path: normalize(path) }),
  }
}

function inspectLocalProjectSelection(
  fs: FileSystem,
  workspaces: Parameters<typeof inspectSelection>[1],
  git: GitRunner,
  config: Parameters<typeof inspectSelection>[3],
  request: Parameters<typeof inspectSelection>[4],
  signal: AbortSignal,
  identityReader: AdministrativeDirectoryIdentityReader = deterministicAdministrativeDirectoryIdentity,
): ReturnType<typeof inspectSelection> {
  return inspectSelection(fs, workspaces, git, config, request, signal, identityReader)
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(async (context) => { await context.fiber.dispose() }))
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }))
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', args, { cwd, windowsHide: true, env: testGitEnvironment() })
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd, windowsHide: true, env: testGitEnvironment() })).stdout.trim()
}

function testGitEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, ...gitInspectionEnvironment() }
}

const GIT_SUBCOMMANDS = new Set([
  'check-attr',
  'config',
  'for-each-ref',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'symbolic-ref',
])

function gitSubcommand(args: readonly string[]): readonly string[] {
  const index = args.findIndex(argument => GIT_SUBCOMMANDS.has(argument))
  return index < 0 ? args : args.slice(index)
}

async function repository(
  prefix = 'saki-inspection-',
  objectFormat?: 'sha1' | 'sha256',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  await git(root, 'init', ...(objectFormat === undefined ? [] : [`--object-format=${objectFormat}`]))
  await git(root, 'config', 'user.name', 'Saki Test')
  await git(root, 'config', 'user.email', 'saki@example.invalid')
  await git(root, 'config', 'core.autocrlf', 'false')
  await git(root, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(root, 'tracked.txt'), 'initial\n')
  await git(root, 'add', 'tracked.txt')
  await git(root, 'commit', '-m', 'initial')
  return root
}

async function unbornRepository(prefix = 'saki-unborn-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  await git(root, 'init')
  await git(root, 'config', 'user.name', 'Saki Test')
  await git(root, 'config', 'user.email', 'saki@example.invalid')
  await git(root, 'config', 'core.autocrlf', 'false')
  await git(root, 'config', 'commit.gpgSign', 'false')
  return root
}

/** Add an initialized Gitlink while making VS Code's derived branch-base cache read-only during tests. */
async function addSubmodule(root: string, source: string, path = 'module'): Promise<void> {
  await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, path)
  const module = join(root, path)
  const branch = await gitText(module, 'branch', '--show-current')
  if (branch !== '') {
    await git(module, 'config', `branch.${branch}.vscode-merge-base`, `origin/${branch}`)
  }
}

async function provider(workspaces: readonly { id: string; path: string }[] = []): Promise<LocalSakiHostExecution> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountLocalHostOperationStorage(ctx, roots)
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('workspaceRegistry', { list: () => [...workspaces] })
  await ctx.plugin(LocalSakiHostExecution, CONFIG)
  return ctx.sakiHostExecution as LocalSakiHostExecution
}

async function localInspectionHarness(): Promise<{ readonly fs: FileSystem; readonly git: GitRunner }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  await ctx.plugin(LocalSubprocessRuntime)
  const executable = await ctx.subprocess.resolveExecutable('git')
  return {
    fs: ctx.fs,
    git: new GitRunner(ctx.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    }),
  }
}

function expectOnlyPrivateRepositoryGit(
  root: string,
  invocations: readonly { readonly cwd: string; readonly args: readonly string[] }[],
  sourceGitDirectories: readonly string[] = [join(root, '.git')],
): void {
  expect(invocations.length).toBeGreaterThan(0)
  const normalizedSourceGitDirectories = sourceGitDirectories.map(path => normalize(path))
  for (const invocation of invocations) {
    expect(normalize(invocation.cwd)).not.toBe(normalize(root))
    expect(normalizedSourceGitDirectories).not.toContain(normalize(invocation.cwd))
    for (const sourceGitDirectory of normalizedSourceGitDirectories) {
      expect(invocation.args).not.toContain(`--git-dir=${sourceGitDirectory}`)
    }
    const parsesExplicitConfig = invocation.args[0] === 'config'
      && invocation.args.includes('--no-includes')
      && invocation.args.some(argument => argument === '--file' || argument.startsWith('--file='))
    const usesPrivateGitDirectory = invocation.args.some(argument =>
      argument.startsWith('--git-dir=')
      && !normalizedSourceGitDirectories.includes(normalize(argument.slice('--git-dir='.length))))
    expect(parsesExplicitConfig || usesPrivateGitDirectory).toBe(true)
  }
}

interface SyntheticFileSystemOptions {
  readonly contains?: (parent: string, child: string) => boolean
  readonly lstat?: (path: string, occurrence: number) => FsPathInfo | undefined
  readonly resolve?: (path: string, occurrence: number) => string
  readonly stat?: (inputPath: string, occurrence: number) => FsInfo | undefined
}

function syntheticFileSystem(
  locator: string,
  selectedPath: string,
  options: SyntheticFileSystemOptions = {},
): FileSystem {
  const lstatOccurrences = new Map<string, number>()
  const resolveOccurrences = new Map<string, number>()
  const statOccurrences = new Map<string, number>()
  const resolvedInputs = new Map<string, string>()
  const pathInfo = (version = 'stable'): FsPathInfo => ({ type: 'directory', version: FsVersion(version) })
  const info = (version = 'stable'): FsInfo => ({ type: 'directory', version: FsVersion(version) })
  const next = (values: Map<string, number>, key: string): number => {
    const occurrence = (values.get(key) ?? 0) + 1
    values.set(key, occurrence)
    return occurrence
  }
  return {
    async lstat(path: string) {
      const occurrence = next(lstatOccurrences, path)
      return options.lstat === undefined ? pathInfo() : options.lstat(path, occurrence)
    },
    async resolve(path: string) {
      const occurrence = next(resolveOccurrences, path)
      const processPath = options.resolve?.(path, occurrence) ?? (path === locator ? selectedPath : path)
      const target: FsTarget = {
        targetKey: FsTargetKey(`${path}\0${occurrence}`),
        displayPath: processPath,
      }
      resolvedInputs.set(target.targetKey, path)
      return target
    },
    async stat(target: FsTarget) {
      const inputPath = resolvedInputs.get(target.targetKey)
      if (inputPath === undefined) throw new Error('synthetic target did not originate from resolve')
      const occurrence = next(statOccurrences, inputPath)
      return options.stat === undefined ? info() : options.stat(inputPath, occurrence)
    },
    processPath(target: FsTarget) { return target.displayPath },
    contains(parent: FsTarget, child: FsTarget) {
      return options.contains?.(parent.displayPath, child.displayPath) ?? child.displayPath.startsWith(parent.displayPath)
    },
  } as unknown as FileSystem
}

describe('LocalSakiHostExecution', () => {
  it.each([
    ['limit', 'unavailable'],
    ['unsupported-index-state', 'unavailable'],
    ['malformed', 'malformed'],
  ] as const)('maps private inspection failure %s to %s', (reason, expected) => {
    expect(projectSelectionRejectionReason(reason)).toBe(expected)
  })

  it.each([
    {
      name: 'rejects an absent worktree-list HEAD',
      record: {},
      head: { kind: 'commit' as const, objectId: '1'.repeat(40) },
      objectFormat: 'sha1' as const,
      expected: false,
    },
    {
      name: 'accepts the same commit',
      record: { head: '1'.repeat(40) },
      head: { kind: 'commit' as const, objectId: '1'.repeat(40) },
      objectFormat: 'sha1' as const,
      expected: true,
    },
    ...(['sha1', 'sha256'] as const).map(objectFormat => ({
      name: `accepts an unborn ${objectFormat} zero id`,
      record: { head: '0'.repeat(objectFormat === 'sha1' ? 40 : 64) },
      head: { kind: 'unborn' as const, symbolicRef: 'refs/heads/main' },
      objectFormat,
      expected: true,
    })),
    {
      name: 'rejects a nonzero unborn id',
      record: { head: '1'.repeat(40) },
      head: { kind: 'unborn' as const, symbolicRef: 'refs/heads/main' },
      objectFormat: 'sha1' as const,
      expected: false,
    },
  ])('$name', ({ record, head, objectFormat, expected }) => {
    expect(worktreeHeadMatches(record, head, objectFormat)).toBe(expected)
  })

  it('parses only an exact complete upstream frame', () => {
    const branch = 'refs/heads/main'
    for (const malformed of [
      Buffer.from([0xff]),
      Buffer.from(`${branch}\0\0\0`),
      Buffer.from('refs/heads/other\0\0\0\n'),
      Buffer.from(`${branch}\0refs/remotes/origin/main\0\0\n`),
    ]) expect(() => parseObservedUpstream(malformed, branch)).toThrow()

    expect(parseObservedUpstream(Buffer.alloc(0), branch)).toBeUndefined()
    expect(parseObservedUpstream(Buffer.from(`${branch}\0\0\0\n`), branch)).toBeUndefined()
    expect(parseObservedUpstream(
      Buffer.from(`${branch}\0refs/remotes/origin/main\0origin/main\0\n`),
      branch,
    )).toEqual({ ref: 'refs/remotes/origin/main', short: 'origin/main' })
  })

  it('rejects unsafe timer and byte bounds while parsing plugin Config', () => {
    expect(() => LocalSakiHostExecution.Config({ gitCommandTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow()
    expect(() => LocalSakiHostExecution.Config({ gitTerminationGraceMs: MAX_TIMER_DELAY_MS + 1 })).toThrow()
    expect(() => LocalSakiHostExecution.Config({ maxGitStdoutBytes: bufferConstants.MAX_LENGTH + 1 })).toThrow()
    expect(() => LocalSakiHostExecution.Config({ maxGitStderrBytes: bufferConstants.MAX_LENGTH + 1 })).toThrow()
    expect(() => LocalSakiHostExecution.Config({ inventoryMaxEntries: MAX_INVENTORY_ENTRIES + 1 })).toThrow()
    expect(() => LocalSakiHostExecution.Config({ baselineMaxEntries: MAX_INHERITED_BASELINE_ENTRIES + 1 })).toThrow()
    for (const field of [
      'maxGitStdoutBytes',
      'maxGitStderrBytes',
      'inventoryMaxEntries',
      'inventoryMaxPathBytes',
      'inventoryMaxGitOutputBytes',
      'inventoryMaxFileBytes',
      'inventoryMaxTotalFileBytes',
      'inventoryMaxCaptureMs',
      'baselineMaxEntries',
      'baselineMaxPathBytes',
      'baselineMaxGitOutputBytes',
      'baselineMaxFileBytes',
      'baselineMaxTotalFileBytes',
      'baselineMaxCaptureMs',
    ] as const) {
      expect(() => LocalSakiHostExecution.Config({ [field]: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    }
  })

  it('accepts only closed non-interactive Git credential helper adapters', () => {
    expect(LocalSakiHostExecution.Config({ pushCredentialHelper: 'git-credential-manager' }))
      .toMatchObject({ pushCredentialHelper: 'git-credential-manager' })
    expect(LocalSakiHostExecution.Config({ pushCredentialHelper: 'git-credential-manager-core' }))
      .toMatchObject({ pushCredentialHelper: 'git-credential-manager-core' })
    expect(LocalSakiHostExecution.Config({})).not.toHaveProperty('pushCredentialHelper')
    // @ts-expect-error -- the runtime parser must reject untyped configuration sources too.
    expect(() => LocalSakiHostExecution.Config({ pushCredentialHelper: '!steal credentials' })).toThrow()
    // @ts-expect-error -- generic Git helpers are intentionally outside the closed adapter set.
    expect(() => LocalSakiHostExecution.Config({ pushCredentialHelper: 'store' })).toThrow()
  })

  it('rejects the smallest index bound that cannot retain a Commit lock marker', () => {
    expect(() => LocalSakiHostExecution.Config({
      operationMaxIndexBytes: MIN_OPERATION_MAX_INDEX_BYTES - 1,
    })).toThrow()
    expect(() => LocalSakiHostExecution.Config({
      operationMaxIndexBytes: MIN_OPERATION_MAX_INDEX_BYTES,
    })).not.toThrow()
  })

  it('rejects Git older than 2.45 at provider load validation', () => {
    for (const version of ['git version 2.44.9\n', 'git version 1.99.99\n']) {
      expect(() => { assertSupportedGitVersion(Buffer.from(version), Buffer.alloc(0)) })
        .toThrow('Git 2.45 or newer')
    }
    for (const version of ['git version 2.45\n', 'git version 2.45.0\n', 'git version 2.46.0\n', 'git version 3.0.0\n']) {
      expect(() => { assertSupportedGitVersion(Buffer.from(version), Buffer.alloc(0)) }).not.toThrow()
    }
    expect(() => { assertSupportedGitVersion(Buffer.from('not a Git version\n'), Buffer.alloc(0)) })
      .toThrow('Git 2.45 or newer')
    expect(() => { assertSupportedGitVersion(Buffer.from([0xff]), Buffer.alloc(0)) })
      .toThrow('Git 2.45 or newer')
    expect(() => {
      assertSupportedGitVersion(Buffer.from('git version 2.45.0\n'), Buffer.from('secret diagnostic'))
    })
      .toThrow('Git 2.45 or newer')
  })

  it('inspects a real dirty repository without retaining changed filenames', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'changed contents\n')
    const execution = await provider([{ id: 'workspace-known', path: await realpath(root) }])

    const result = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, new AbortController().signal)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inspection.trusted.canonicalWorktreePath).toBe(await realpath(root))
    expect(result.inspection.projection).toMatchObject({
      hostId: HOST_ID,
      displayLocation: basename(root),
      head: { kind: 'commit' },
      inheritedChangeEntryCount: 1,
      workspaceId: 'workspace-known',
      automaticMutationEligible: false,
      blockingReasons: ['dirty'],
      baseline: { kind: 'complete' },
    })
    if (result.inspection.projection.head.kind === 'commit') {
      expect(result.inspection.projection.head.symbolicRef).toMatch(/^refs\/heads\//u)
    }
    expect(JSON.stringify(result.inspection.projection)).not.toContain('tracked.txt')
  })

  it('inspects an unborn attached worktree without inventing a zero commit id', async () => {
    const root = await unbornRepository()
    const symbolicRef = await gitText(root, 'symbolic-ref', 'HEAD')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection).toMatchObject({
      observationVersion: 2,
      head: { kind: 'unborn', symbolicRef },
      inheritedChangeEntryCount: 0,
      automaticMutationEligible: true,
      blockingReasons: [],
      fingerprint: { version: 2 },
      baseline: { kind: 'complete', entries: [] },
    })
    expect(JSON.stringify(result.inspection.projection)).not.toMatch(/"objectId":"0+"/u)
  })

  it('resolves a selected repository subdirectory to its canonical Git top level', async () => {
    const root = await repository()
    const selected = join(root, 'source', 'nested')
    await mkdir(selected, { recursive: true })
    const canonicalRoot = await realpath(root)
    const execution = await provider([{ id: 'workspace-known', path: canonicalRoot }])

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: selected },
      new AbortController().signal,
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.inspection.trusted.canonicalWorktreePath).toBe(canonicalRoot)
    expect(result.inspection.projection).toMatchObject({
      displayLocation: basename(root),
      workspaceId: 'workspace-known',
      inheritedChangeEntryCount: 0,
      automaticMutationEligible: true,
      blockingReasons: [],
    })
  })

  it('keeps readable change membership when a tracked file becomes a directory', async () => {
    const root = await repository()
    await rm(join(root, 'tracked.txt'))
    await mkdir(join(root, 'tracked.txt'))
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection).toMatchObject({
      inheritedChangeEntryCount: 1,
      automaticMutationEligible: false,
      blockingReasons: ['dirty', 'baseline-unavailable'],
      baseline: { kind: 'unavailable', reason: 'unsupported-state' },
    })
  })

  it('replaces an unsafe repository basename with a fixed display label', async () => {
    const root = await repository('saki-\u202e-')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection.displayLocation).toBe('repository')
    expect(JSON.stringify(result.inspection.projection)).not.toContain('\u202e')
  })

  it('labels the Local Host filesystem root without projecting its path spelling', () => {
    expect(projectDisplayLocation(parse(process.cwd()).root)).toBe('filesystem root')
  })

  it('treats linked and detached worktrees as distinct selections in one repository family', async () => {
    const root = await repository()
    const linked = `${root}-linked`
    roots.push(linked)
    await git(root, 'worktree', 'add', '--detach', linked)
    const execution = await provider()

    const main = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, new AbortController().signal)
    const other = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: linked }, new AbortController().signal)

    expect(main.ok, JSON.stringify(main)).toBe(true)
    expect(other.ok, JSON.stringify(other)).toBe(true)
    if (!main.ok || !other.ok) return
    expect(other.inspection.projection.head).toMatchObject({ kind: 'commit' })
    expect(other.inspection.projection.head).not.toHaveProperty('symbolicRef')
    expect(main.inspection.trusted.canonicalCommonGitDirectory).toBe(other.inspection.trusted.canonicalCommonGitDirectory)
    expect(main.inspection.trusted.canonicalGitDirectory).not.toBe(other.inspection.trusted.canonicalGitDirectory)
    expect(main.inspection.projection.fingerprint).not.toEqual(other.inspection.projection.fingerprint)
  }, 15_000)

  it('inspects a local separate-git-dir through the same private control plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-separate-worktree-'))
    const gitDirectory = `${root}-git`
    roots.push(root, gitDirectory)
    await git(root, 'init', `--separate-git-dir=${gitDirectory}`)
    await git(root, 'config', 'user.name', 'Saki Test')
    await git(root, 'config', 'user.email', 'saki@example.invalid')
    await writeFile(join(root, 'tracked.txt'), 'initial\n')
    await git(root, 'add', 'tracked.txt')
    await git(root, 'commit', '-m', 'initial')
    const { fs, git: actual } = await localInspectionHarness()
    const invocations: Array<{ readonly cwd: string; readonly args: readonly string[] }> = []
    const recording = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        invocations.push({ cwd, args: [...args] })
        return await actual.run(cwd, args, signal, stdin, outputBudget)
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      fs,
      { list: () => [] },
      recording,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.inspection.trusted).toMatchObject({
      canonicalWorktreePath: await realpath(root),
      canonicalGitDirectory: await realpath(gitDirectory),
      canonicalCommonGitDirectory: await realpath(gitDirectory),
    })
    expectOnlyPrivateRepositoryGit(root, invocations, [gitDirectory])
  }, 15_000)

  it('exposes only the fixed read-only Git query face', async () => {
    const root = await repository()
    const harness = await localInspectionHarness()
    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(root),
      CONFIG.inventoryMaxFileBytes,
      new AbortController().signal,
    )
    expect(opened.kind).toBe('repository')
    if (opened.kind !== 'repository') return
    await using view = opened.view
    const outsideConfig = join(root, 'unsafe-config')

    await expect(view.git.run(root, [
      'config', '--file', outsideConfig, '--add', 'saki.unsafe', 'true',
    ], new AbortController().signal)).rejects.toThrow()
    await expect(view.git.run(root, [
      'symbolic-ref', 'HEAD', 'refs/heads/unsafe',
    ], new AbortController().signal)).rejects.toThrow()
    await expect(readFile(outsideConfig)).rejects.toThrow()
  })

  it('rejects an ordinary repository whose effective worktree redirects elsewhere', async () => {
    const root = await repository()
    const other = await mkdtemp(join(tmpdir(), 'saki-other-worktree-'))
    roots.push(other)
    await git(root, 'config', 'core.worktree', other)
    const harness = await localInspectionHarness()

    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(root),
      CONFIG.inventoryMaxFileBytes,
      new AbortController().signal,
    )

    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
    expect(opened.kind).toBe('ambiguous')
  })

  it('ignores main-worktree bare and worktree values for a linked worktree when worktree config is disabled', async () => {
    const root = await repository()
    const linked = `${root}-linked-main-config`
    const other = await mkdtemp(join(tmpdir(), 'saki-other-worktree-'))
    roots.push(linked, other)
    await git(root, 'worktree', 'add', '--detach', linked)
    const commonGitDirectory = join(root, '.git')
    await git(root, `--git-dir=${commonGitDirectory}`, 'config', 'core.worktree', other)
    await git(root, `--git-dir=${commonGitDirectory}`, 'config', 'core.bare', 'true')
    const harness = await localInspectionHarness()

    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(linked),
      CONFIG.inventoryMaxFileBytes,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
  })

  it('uses active worktree config to override linked common bare and worktree values', async () => {
    const root = await repository()
    const linked = `${root}-linked-worktree-config`
    const other = await mkdtemp(join(tmpdir(), 'saki-other-worktree-'))
    roots.push(linked, other)
    await git(root, 'worktree', 'add', '--detach', linked)
    await git(root, 'config', 'extensions.worktreeConfig', 'true')
    await git(linked, 'config', '--worktree', 'core.bare', 'false')
    await git(linked, 'config', '--worktree', 'core.worktree', await realpath(linked))
    const commonGitDirectory = join(root, '.git')
    await git(root, `--git-dir=${commonGitDirectory}`, 'config', 'core.worktree', other)
    await git(root, `--git-dir=${commonGitDirectory}`, 'config', 'core.bare', 'true')
    const harness = await localInspectionHarness()

    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(linked),
      CONFIG.inventoryMaxFileBytes,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
  })

  it('rejects repository identity values from active worktree config', async () => {
    const root = await repository()
    const linked = `${root}-linked-worktree-identity`
    roots.push(linked)
    await git(root, 'worktree', 'add', '--detach', linked)
    await git(root, 'config', 'extensions.worktreeConfig', 'true')
    const linkedGitDirectory = await gitText(linked, 'rev-parse', '--absolute-git-dir')
    const harness = await localInspectionHarness()
    for (const config of [
      '[core]\n\trepositoryFormatVersion = 1\n',
      '[extensions]\n\tobjectFormat = sha256\n',
      '[extensions]\n\trefStorage = reftable\n',
    ]) {
      await writeFile(join(linkedGitDirectory, 'config.worktree'), config)
      const opened = await openSafeRepositoryView(
        harness.fs,
        harness.git,
        await realpath(linked),
        CONFIG.inventoryMaxFileBytes,
        new AbortController().signal,
      )
      expect(opened.kind).toBe('unavailable')
    }
  })

  it('rejects a linked active worktree redirect while retaining common fallback semantics', async () => {
    const root = await repository()
    const linked = `${root}-linked-active-redirect`
    const other = await mkdtemp(join(tmpdir(), 'saki-other-worktree-'))
    roots.push(linked, other)
    await git(root, 'worktree', 'add', '--detach', linked)
    await git(root, 'config', 'extensions.worktreeConfig', 'true')
    await git(linked, 'config', '--worktree', 'core.worktree', other)
    const harness = await localInspectionHarness()
    const redirected = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(linked),
      CONFIG.inventoryMaxFileBytes,
      new AbortController().signal,
    )
    expect(redirected.kind).toBe('ambiguous')

    await git(linked, 'config', '--worktree', '--unset', 'core.worktree')
    const commonGitDirectory = join(root, '.git')
    await git(root, `--git-dir=${commonGitDirectory}`, 'config', 'core.bare', 'true')
    const inheritedBare = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(linked),
      CONFIG.inventoryMaxFileBytes,
      new AbortController().signal,
    )
    expect(inheritedBare.kind).toBe('bare')
  })

  it('resolves linked worktree-specific core.worktree relative to the current Git directory', async () => {
    const root = await repository()
    const linked = `${root}-linked-relative-worktree`
    roots.push(linked)
    await git(root, 'worktree', 'add', '--detach', linked)
    await git(root, 'config', 'extensions.worktreeConfig', 'true')
    const linkedGitDirectory = await gitText(linked, 'rev-parse', '--absolute-git-dir')
    await git(linked, 'config', '--worktree', 'core.worktree', relative(linkedGitDirectory, await realpath(linked)))
    const harness = await localInspectionHarness()

    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(linked),
      CONFIG.inventoryMaxFileBytes,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('repository')
    if (opened.kind === 'repository') await opened.view[Symbol.asyncDispose]()
  })

  it('rejects an invalid common bare value even when a linked worktree would ignore it', async () => {
    const root = await repository()
    const linked = `${root}-linked-invalid-common`
    roots.push(linked)
    await git(root, 'worktree', 'add', '--detach', linked)
    await git(root, `--git-dir=${join(root, '.git')}`, 'config', 'core.bare', 'invalid')
    const harness = await localInspectionHarness()

    const opened = await openSafeRepositoryView(
      harness.fs,
      harness.git,
      await realpath(linked),
      CONFIG.inventoryMaxFileBytes,
      new AbortController().signal,
    )

    expect(opened.kind).toBe('unavailable')
  })

  it('preserves SHA-256 repository semantics through the private control plane', async () => {
    const root = await repository('saki-sha256-', 'sha256')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection.objectFormat).toBe('sha256')
    expect(result.inspection.projection.head).toMatchObject({
      kind: 'commit',
    })
    if (result.inspection.projection.head.kind === 'commit') {
      expect(result.inspection.projection.head.objectId).toMatch(/^[0-9a-f]{64}$/u)
    }
  })

  it('fails closed when a split index depends on an uncaptured shared index', async () => {
    const root = await repository()
    await git(root, 'update-index', '--split-index')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('does not mistake an uninitialized submodule directory for the superproject', async () => {
    const source = await repository()
    await writeFile(join(source, 'tracked.txt'), 'second\n')
    await git(source, 'add', 'tracked.txt')
    await git(source, 'commit', '-m', 'second')
    const root = await repository()
    await addSubmodule(root, source)
    await git(root, 'commit', '-am', 'submodule')
    const execution = await provider()
    const initialized = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )
    expect(initialized.ok).toBe(true)
    if (initialized.ok) {
      expect(initialized.inspection.projection).toMatchObject({
        inheritedChangeEntryCount: 0,
        conversionAmbiguous: true,
        automaticMutationEligible: false,
        blockingReasons: ['conversion-ambiguous'],
        baseline: { kind: 'complete', entries: [] },
      })
    }
    await git(root, 'submodule', 'deinit', '-f', 'module')
    await mkdir(join(root, 'module'), { recursive: true })

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection).toMatchObject({
      inheritedChangeEntryCount: 1,
      automaticMutationEligible: false,
      blockingReasons: ['dirty', 'baseline-unavailable'],
      baseline: { kind: 'unavailable', reason: 'unsupported-state' },
    })
    expect(JSON.stringify(result.inspection.projection.baseline)).not.toContain(
      await gitText(root, 'rev-parse', 'HEAD'),
    )
  }, 30_000)

  it.skipIf(process.platform !== 'win32')('uses the stable canonical spelling for nested gitlink admission and private --work-tree arguments', async () => {
    const source = await repository()
    const root = await repository()
    const indexedModule = join(root, 'ModuleCase')
    const intermediate = join(root, 'module-case-intermediate')
    const canonicalModule = join(root, 'modulecase')
    await addSubmodule(root, source, 'ModuleCase')
    await git(root, 'commit', '-am', 'submodule')
    await rename(indexedModule, intermediate)
    await rename(intermediate, canonicalModule)
    const canonicalPath = await realpath(canonicalModule)
    const harness = await localInspectionHarness()
    const invocations: Array<{ readonly cwd: string; readonly args: readonly string[] }> = []
    const recording = {
      run: async (...args: Parameters<GitRunner['run']>) => {
        invocations.push({ cwd: args[0], args: [...args[1]] })
        return await harness.git.run(...args)
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      harness.fs,
      { list: () => [] },
      recording,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection.baseline).toMatchObject({ kind: 'complete', entries: [] })
    const nestedReads = invocations.filter(({ args }) => gitSubcommand(args).at(-1) === 'HEAD^{commit}')
    expect(nestedReads.length).toBeGreaterThan(0)
    expect(nestedReads.every(({ args }) => args.includes(`--work-tree=${canonicalPath}`))).toBe(true)
    expect(nestedReads.every(({ args }) => !args.includes(`--work-tree=${indexedModule}`))).toBe(true)
  }, 15_000)

  it('contains unstable nested gitlink directory resolution as unavailable evidence', async () => {
    const source = await repository()
    const root = await repository()
    await addSubmodule(root, source)
    await git(root, 'commit', '-am', 'submodule')
    const module = normalize(join(root, 'module'))
    const nestedMarker = normalize(join(module, '.git'))
    const harness = await localInspectionHarness()
    for (const fault of [
      'first-missing',
      'first-reparse',
      'first-target-missing',
      'first-target-file',
      'second-missing',
      'second-reparse',
      'version-changed',
      'second-target-missing',
      'second-target-file',
      'canonical-target-changed',
    ] as const) {
      let lstatReads = 0
      let resolveReads = 0
      let statReads = 0
      let nestedMarkerProbes = 0
      let nestedGitProbes = 0
      const filesystem = new Proxy(harness.fs, {
        get(target, property) {
          if (property === 'lstat') {
            return async (...args: Parameters<FileSystem['lstat']>) => {
              const candidate = normalize(args[0])
              if (candidate === nestedMarker) nestedMarkerProbes += 1
              const actual = await target.lstat(...args)
              if (candidate !== module) return actual
              lstatReads += 1
              const second = lstatReads % 2 === 0
              if (fault === 'first-missing') return undefined
              if (fault === 'first-reparse' && actual !== undefined) return { ...actual, type: 'symlink' as const }
              if (fault === 'second-missing' && second) return undefined
              if (fault === 'second-reparse' && second && actual !== undefined) {
                return { ...actual, type: 'symlink' as const }
              }
              if (fault === 'version-changed' && second && actual !== undefined) {
                return { ...actual, version: FsVersion('changed') }
              }
              return actual
            }
          }
          if (property === 'resolve') {
            return async (...args: Parameters<FileSystem['resolve']>) => {
              if (normalize(args[0]) !== module) return await target.resolve(...args)
              resolveReads += 1
              if (fault === 'canonical-target-changed' && resolveReads % 2 === 0) {
                return await target.resolve(dirname(module), args[1])
              }
              return await target.resolve(...args)
            }
          }
          if (property === 'stat') {
            return async (...args: Parameters<FileSystem['stat']>) => {
              const actual = await target.stat(...args)
              if (normalize(target.processPath(args[0])) !== module) return actual
              statReads += 1
              const second = statReads % 2 === 0
              if (fault === 'first-target-missing') return undefined
              if (fault === 'first-target-file' && actual !== undefined) return { ...actual, type: 'file' as const }
              if (fault === 'second-target-missing' && second) return undefined
              if (fault === 'second-target-file' && second && actual !== undefined) {
                return { ...actual, type: 'file' as const }
              }
              return actual
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          if (typeof value !== 'function') return value
          const method = value as (...args: unknown[]) => unknown
          return (...args: unknown[]): unknown => method.apply(target, args)
        },
      })
      const recording = {
        run: async (...args: Parameters<GitRunner['run']>) => {
          const nestedWorkTree = args[1].some(argument => argument.startsWith('--work-tree=')
            && normalize(argument.slice('--work-tree='.length)) === module)
          if (normalize(args[0]) === module || nestedWorkTree) nestedGitProbes += 1
          return await harness.git.run(...args)
        },
      } as GitRunner

      const result = await inspectLocalProjectSelection(
        filesystem,
        { list: () => [] },
        recording,
        CONFIG,
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      )

      expect(result.ok, fault).toBe(true)
      if (result.ok) expect(result.inspection.projection.baseline, fault).toMatchObject({
        kind: 'unavailable',
        reason: 'unsupported-state',
      })
      expect(nestedMarkerProbes, fault).toBe(0)
      expect(nestedGitProbes, fault).toBe(0)
    }
  }, 60_000)

  it('contains a nonzero nested HEAD observation as unavailable submodule evidence', async () => {
    const source = await repository()
    const root = await repository()
    await addSubmodule(root, source)
    await git(root, 'commit', '-am', 'submodule')
    const harness = await localInspectionHarness()
    let rejected = 0
    const missingNestedHead = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        if (args.includes(`--work-tree=${join(root, 'module')}`)
          && gitSubcommand(args).at(-1) === 'HEAD^{commit}') {
          rejected += 1
          throw new GitCommandError('nonzero', 128)
        }
        return await harness.git.run(cwd, args, signal, stdin, outputBudget)
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      harness.fs,
      { list: () => [] },
      missingNestedHead,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(rejected).toBeGreaterThan(0)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.inspection.projection.baseline).toMatchObject({
      kind: 'unavailable', reason: 'unsupported-state',
    })
  }, 15_000)

  it('blocks automatic mutation for staged, unstaged, and untracked changes inside an initialized submodule', async () => {
    const source = await repository()
    const root = await repository()
    await addSubmodule(root, source)
    await git(root, 'commit', '-am', 'submodule')
    const module = join(root, 'module')
    const execution = await provider()
    const cases: readonly [string, () => Promise<void>][] = [
      ['staged', async () => {
        await writeFile(join(module, 'tracked.txt'), 'staged\n')
        await git(module, 'add', 'tracked.txt')
      }],
      ['unstaged', async () => {
        await writeFile(join(module, 'tracked.txt'), 'unstaged\n')
      }],
      ['untracked', async () => {
        await writeFile(join(module, 'untracked.txt'), 'untracked\n')
      }],
    ]

    for (const [kind, mutate] of cases) {
      await mutate()
      const result = await execution.inspectProjectSelection(
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      )

      expect(result.ok, `${kind}: ${JSON.stringify(result)}`).toBe(true)
      if (result.ok) {
        expect(result.inspection.projection, kind).toMatchObject({
          inheritedChangeEntryCount: 0,
          conversionAmbiguous: true,
          automaticMutationEligible: false,
          blockingReasons: ['conversion-ambiguous'],
          baseline: { kind: 'complete', entries: [] },
        })
      }
      await git(module, 'reset', '--hard', 'HEAD')
      await git(module, 'clean', '-fd')
    }
  }, 60_000)

  it('charges only nested HEAD output to retained gitlink baseline evidence', async () => {
    const source = await repository()
    const recorded = await gitText(source, 'rev-parse', 'HEAD')
    await writeFile(join(source, 'tracked.txt'), 'second\n')
    await git(source, 'add', 'tracked.txt')
    await git(source, 'commit', '-m', 'second')
    const current = await gitText(source, 'rev-parse', 'HEAD')
    const execution = await provider()

    const inspectDirtyGitlink = async (prefix: string): Promise<number> => {
      const root = await repository(prefix)
      await addSubmodule(root, source)
      await git(join(root, 'module'), 'checkout', recorded)
      await git(root, 'add', '.gitmodules', 'module')
      await git(root, 'commit', '-m', 'submodule')
      await git(join(root, 'module'), 'checkout', current)

      const result = await execution.inspectProjectSelection(
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      )

      expect(result.ok).toBe(true)
      if (!result.ok || result.inspection.projection.baseline.kind !== 'complete') return -1
      expect(result.inspection.projection.baseline.entries).toMatchObject([
        { worktree: { kind: 'submodule', objectId: current } },
      ])
      return result.inspection.projection.baseline.observed.gitOutputBytes
    }

    const shortPathBytes = await inspectDirtyGitlink('saki-gitlink-short-')
    const longPathBytes = await inspectDirtyGitlink(`saki-gitlink-${'long-'.repeat(20)}`)

    expect(longPathBytes).toBe(shortPathBytes)
  }, 30_000)

  it('retains blocking evidence when a gitlink administrative directory escapes the selected repository', async () => {
    const outside = await repository()
    const root = await repository()
    const module = join(root, 'module')
    await mkdir(module)
    await writeFile(join(module, '.git'), `gitdir: ${join(outside, '.git').replaceAll('\\', '/')}\n`)
    await git(root, 'update-index', '--add', '--cacheinfo', '160000', await gitText(outside, 'rev-parse', 'HEAD'), 'module')
    await git(root, 'commit', '-m', 'external gitlink')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection).toMatchObject({
      inheritedChangeEntryCount: 1,
      automaticMutationEligible: false,
      blockingReasons: ['dirty', 'baseline-unavailable'],
      baseline: { kind: 'unavailable', reason: 'unsupported-state' },
    })
    expect(JSON.stringify(result.inspection.projection)).not.toContain(outside)
  }, 15_000)

  it('applies the same private config admission to an initialized gitlink', async () => {
    const source = await repository()
    const root = await repository()
    await addSubmodule(root, source)
    await git(root, 'commit', '-am', 'submodule')
    const module = join(root, 'module')
    const nestedGitDirectory = await realpath(await gitText(module, 'rev-parse', '--absolute-git-dir'))
    const includedConfig = join(source, 'nested-included-config')
    await writeFile(includedConfig, '[core]\n\tbare = true\n')
    await git(module, 'config', '--local', 'include.path', includedConfig.replaceAll('\\', '/'))
    expect(await gitText(module, 'config', '--includes', '--get', 'core.bare')).toBe('true')
    const { fs, git: actual } = await localInspectionHarness()
    const invocations: Array<{ readonly cwd: string; readonly args: readonly string[] }> = []
    const recording = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        invocations.push({ cwd, args: [...args] })
        return await actual.run(cwd, args, signal, stdin, outputBudget)
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      fs,
      { list: () => [] },
      recording,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: true,
      inspection: {
        projection: {
          automaticMutationEligible: false,
        },
      },
    })
    expectOnlyPrivateRepositoryGit(root, invocations, [join(root, '.git'), nestedGitDirectory])
    expect(invocations.every(invocation => normalize(invocation.cwd) !== normalize(module))).toBe(true)
    expect(invocations.some(invocation =>
      invocation.args.includes(`--work-tree=${module}`)
      && invocation.args.some(argument => argument.startsWith('--git-dir='))))
      .toBe(false)
  }, 15_000)

  it('fails closed for a real skip-worktree index entry', async () => {
    const root = await repository()
    await git(root, 'update-index', '--skip-worktree', 'tracked.txt')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it.each([
    { flag: 'S', bound: false, expected: 'unavailable' },
    { flag: 'h', bound: true, expected: 'unsupported-index-state' },
  ] as const)('rejects a final-observation $flag index flag with bound=$bound', async ({
    flag,
    bound,
    expected,
  }) => {
    const root = await repository()
    const harness = await localInspectionHarness()
    const workspaceId = WorkspaceId('workspace-final-index-state')
    const workspaces = { list: () => [{ id: workspaceId, path: root }] }
    const selected = await inspectLocalProjectSelection(
      harness.fs,
      workspaces,
      harness.git,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )
    expect(selected.ok).toBe(true)
    if (!selected.ok) return

    let indexReads = 0
    const injected = {
      run: async (...args: Parameters<GitRunner['run']>) => {
        const output = await harness.git.run(...args)
        const command = gitSubcommand(args[1])
        const targetCommand = command[0] === 'ls-files' && (flag === 'S'
          ? command.includes('--stage') && command.includes('-t')
          : command.includes('-v'))
        if (!targetCommand || ++indexReads !== 2) return output
        return {
          ...output,
          stdout: Buffer.from(output.stdout.toString('utf8').replace(/^H /mu, `${flag} `)),
        }
      },
    } as GitRunner
    const requirements = bound
      ? {
        boundResource: {
          workspaceId,
          trusted: selected.inspection.trusted,
        },
        rejectUnsupportedIndexState: true,
      }
      : undefined

    const result = await inspectStableLocalProjectSelection(
      harness.fs,
      workspaces,
      injected,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
      deterministicAdministrativeDirectoryIdentity,
      requirements,
    )

    expect(indexReads).toBe(2)
    expect(result).toEqual({ ok: false, reason: expected })
  }, 30_000)

  it('retains all real conflict stages in a complete inherited baseline', async () => {
    const root = await repository()
    const main = await gitText(root, 'branch', '--show-current')
    await git(root, 'checkout', '-b', 'conflict-other')
    await writeFile(join(root, 'tracked.txt'), 'other\n')
    await git(root, 'commit', '-am', 'other')
    await git(root, 'checkout', main)
    await writeFile(join(root, 'tracked.txt'), 'main\n')
    await git(root, 'commit', '-am', 'main')
    await expect(run('git', ['merge', 'conflict-other'], { cwd: root, windowsHide: true })).rejects.toBeDefined()
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection).toMatchObject({
      inheritedChangeEntryCount: 1,
      automaticMutationEligible: false,
      blockingReasons: ['dirty'],
      baseline: {
        kind: 'complete',
        entries: [{
          statusKind: 'unmerged',
          stages: [
            { kind: 'object' }, { kind: 'object' }, { kind: 'object' },
          ],
          worktree: { kind: 'regular' },
        }],
      },
    })
  })

  it.skipIf(process.platform === 'win32')('captures a real changed worktree symlink without following it', async () => {
    const root = await repository()
    const targetRoot = await mkdtemp(join(tmpdir(), 'saki-inspection-symlink-target-'))
    roots.push(targetRoot)
    const firstTarget = join(targetRoot, 'first-target')
    const secondTarget = join(targetRoot, 'second-target')
    await writeFile(firstTarget, 'first secret bytes')
    await writeFile(secondTarget, 'second secret bytes')
    const link = join(root, 'tracked-link')
    await symlink(firstTarget, link, 'file')
    await git(root, 'add', 'tracked-link')
    await git(root, 'commit', '-m', 'symlink')
    await rm(link)
    await symlink(secondTarget, link, 'file')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection.baseline).toMatchObject({
      kind: 'complete',
      entries: [{ statusKind: 'tracked', worktree: { kind: 'symlink' } }],
    })
    expect(JSON.stringify(result.inspection.projection)).not.toMatch(/first-target|second-target|secret/u)
  })

  it('does not probe or reject a healthy selection because another real worktree record is prunable', async () => {
    const root = await repository()
    const linked = `${root}-prunable`
    roots.push(linked)
    await git(root, 'worktree', 'add', '--detach', linked)
    const admin = await gitText(linked, 'rev-parse', '--absolute-git-dir')
    await writeFile(join(admin, 'gitdir'), `${linked}-missing/.git\n`)
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
  })

  it('rejects a selected linked worktree whose reciprocal marker is missing', async () => {
    const root = await repository()
    const linked = `${root}-selected-prunable`
    roots.push(linked)
    await git(root, 'worktree', 'add', '--detach', linked)
    const admin = await gitText(linked, 'rev-parse', '--absolute-git-dir')
    await rm(join(admin, 'gitdir'))
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: linked },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'prunable' })
  })

  it.skipIf(process.platform === 'win32')('treats a POSIX backslash as a filename character', async () => {
    const root = await repository()
    await writeFile(join(root, 'back\\slash.txt'), 'portable bytes\n')
    await git(root, 'add', 'back\\slash.txt')
    await git(root, 'commit', '-m', 'backslash filename')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.inspection.projection.inheritedChangeEntryCount).toBe(0)
  })

  it('rejects a caller reparse alias before repository inspection', async () => {
    const root = await repository()
    const alias = `${root}-alias`
    roots.push(alias)
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const execution = await provider()

    const result = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: alias }, new AbortController().signal)

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('never projects ambiguous credential-bearing remote text as a coordinate', () => {
    const values = [
      'file://user:secret@host/private/customer',
      'ssh://user:secret@@host/private/customer',
      'https://user:secret@@host/private/customer',
      'host:private:secret@customer/path',
      'C:\\private\\customer-secret',
      'C:customer-secret/repo.git',
    ]
    const observations = values.map(sanitizeRemote)

    expect(observations).toEqual([
      { transport: 'file' },
      { transport: 'ssh' },
      { transport: 'https' },
      { transport: 'other' },
      { transport: 'file' },
      { transport: 'file' },
    ])
    expect(JSON.stringify(observations)).not.toMatch(/user|secret|private|customer/u)
  })

  it('keeps empty and control-bearing remote values class-only', async () => {
    expect(sanitizeRemote('')).toEqual({ transport: 'other' })
    expect(sanitizeRemote('https://example.com/org/repo\nLEAKED_REMOTE_SECRET'))
      .toEqual({ transport: 'https' })

    const root = await repository()
    await git(root, 'config', 'remote.empty.url', '')
    await git(root, 'config', 'remote.hidden.url', 'https://example.com/org/repo\nLEAKED_REMOTE_SECRET')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection.remotes).toEqual([
      { transport: 'https' },
      { transport: 'other' },
    ])
    expect(JSON.stringify(result.inspection.projection)).not.toContain('LEAKED_REMOTE_SECRET')
  })

  it.each([
    { name: 'accepts Git exit 1 when no remote URL configuration exists', error: new GitCommandError('nonzero', 1) },
    { name: 'contains a failed remote URL inspection', error: new GitCommandError('timeout') },
  ])('$name', async ({ error }) => {
    const failing = {
      run: async () => { throw error },
    } as unknown as GitRunner
    const inspected = inspectRemotes(failing, 'repository', new AbortController().signal)
    if (error.code === 'nonzero') {
      await expect(inspected).resolves.toEqual([])
    } else {
      await expect(inspected).rejects.toBe(error)
    }
  })

  it('projects canonical public-GitHub candidates from admitted remotes', async () => {
    const root = await repository()
    await git(root, 'remote', 'add', 'origin', 'https://github.com/BreakfastDaPaiDang/Saki.git')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection.githubRepositoryCandidates)
      .toEqual(['github.com/breakfastdapaidang/saki'])
  }, 15_000)

  it('rejects a remote inventory at the fixed unique-observation cap', async () => {
    const root = await repository()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(LocalSubprocessRuntime)
    const executable = await ctx.subprocess.resolveExecutable('git')
    const actual = new GitRunner(ctx.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    })
    const capped = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        const command = gitSubcommand(args)
        if (command[0] === 'config' && command.includes('--get-regexp')) {
          const records = Buffer.from(Array.from({ length: MAX_SAFE_REMOTES + 1 }, (_, index) =>
            `remote.r${index}.url\nhttps://host${index}.example/org/repo\0`).join(''))
          if (outputBudget !== undefined && !outputBudget.observe(records.byteLength)) {
            throw new GitCommandError('stdout-limit')
          }
          return { stdout: records, stderr: Buffer.alloc(0) }
        }
        return await actual.run(cwd, args, signal, stdin, outputBudget)
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      ctx.fs,
      { list: () => [] },
      capped,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('keeps material remote ports distinct and omits empty repository coordinates', () => {
    expect(sanitizeRemote('http://host.example/repo.git')).toEqual({ transport: 'other' })
    expect(sanitizeRemote('ssh://host.example/repo.git')).toEqual({
      transport: 'ssh', coordinate: 'host.example/repo',
    })
    expect(sanitizeRemote('ssh://host.example:2222/repo.git')).toEqual({
      transport: 'ssh', coordinate: 'host.example:2222/repo',
    })
    expect(sanitizeRemote('https://host.example:8443/repo.git')).toEqual({
      transport: 'https', coordinate: 'host.example:8443/repo',
    })
    expect(sanitizeRemote('github.com:org/repo.git')).toEqual({
      transport: 'ssh', coordinate: 'github.com/org/repo',
    })
    expect(sanitizeRemote('git@github.com:org/repo.git')).toEqual({
      transport: 'ssh', coordinate: 'github.com/org/repo',
    })
    expect(sanitizeRemote('user:secret@host/path')).toEqual({ transport: 'other' })
    expect(sanitizeRemote('ssh://host.example/')).toEqual({ transport: 'ssh' })
    expect(sanitizeRemote('https://host.example/.git')).toEqual({ transport: 'https' })
    expect(sanitizeRemote('repo.git')).toEqual({ transport: 'file' })
    expect(sanitizeRemote('relative/repo.git')).toEqual({ transport: 'file' })
    expect(sanitizeRemote('\\\\server\\share\\repo.git')).toEqual({ transport: 'file' })
    expect(sanitizeRemote('/private/repo\nsecret')).toEqual({ transport: 'file' })
    expect(sanitizeRemote('relative\nsecret')).toEqual({ transport: 'other' })
    expect(sanitizeRemote('file://host/path\nsecret')).toEqual({ transport: 'file' })
    expect(sanitizeRemote('foo://host/path\nsecret')).toEqual({ transport: 'other' })
    expect(sanitizeRemote('bad_host:org/repo')).toEqual({ transport: 'ssh' })
    expect(sanitizeRemote('https:/repo')).toEqual({ transport: 'https' })
    expect(sanitizeRemote('ssh:/repo')).toEqual({ transport: 'ssh' })
    expect(sanitizeRemote('file://host/repo')).toEqual({ transport: 'file' })
    expect(sanitizeRemote('ssh://[')).toEqual({ transport: 'ssh' })
    expect(sanitizeRemote('::')).toEqual({ transport: 'other' })
    expect(sanitizeRemote('https://host.example/org/%aa/repo.git')).toEqual({
      transport: 'https', coordinate: 'host.example/org/%AA/repo',
    })
  })

  it('blocks an untracked literal unspecified filter without launching it', async () => {
    const root = await repository()
    const script = join(root, 'filter-sentinel.mjs')
    const marker = join(root, 'filter-ran')
    await writeFile(script, [
      "import { appendFileSync } from 'node:fs'",
      'appendFileSync(process.argv[2], "ran\\n")',
      'process.stdin.pipe(process.stdout)',
      '',
    ].join('\n'))
    await writeFile(join(root, '.gitattributes'), 'untracked.txt filter=unspecified\n')
    await git(root, 'add', '.gitattributes', 'filter-sentinel.mjs')
    await git(root, 'commit', '-m', 'attributes')
    const command = [process.execPath, script, marker]
      .map(value => `'${value.replaceAll("'", "'\"'\"'")}'`)
      .join(' ')
    await git(root, 'config', 'filter.unspecified.clean', command)
    await git(root, 'config', 'filter.unspecified.required', 'true')
    await writeFile(join(root, 'untracked.txt'), 'untracked\n')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    await expect(readFile(marker)).rejects.toThrow()
    expect(result).toMatchObject({
      ok: true,
      inspection: {
        projection: {
          inheritedChangeEntryCount: 1,
          automaticMutationEligible: false,
          conversionAmbiguous: true,
          baseline: { kind: 'complete', entries: [{ statusKind: 'untracked' }] },
        },
      },
    })
    if (result.ok) expect(result.inspection.projection.blockingReasons).toContain('conversion-ambiguous')
  })

  it('rejects a direct repository fsmonitor executable without launching it', async () => {
    const root = await repository()
    const script = join(root, 'fsmonitor-sentinel.mjs')
    const marker = join(root, 'fsmonitor-ran')
    await writeFile(script, [
      "import { appendFileSync } from 'node:fs'",
      'appendFileSync(process.argv[2], "ran\\n")',
      '',
    ].join('\n'))
    const command = [process.execPath, script, marker]
      .map(value => `'${value.replaceAll("'", "'\"'\"'")}'`)
      .join(' ')
    await git(root, 'config', 'core.fsmonitor', command)
    await expect(readFile(marker)).rejects.toThrow()
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    await expect(readFile(marker)).rejects.toThrow()
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('scrubs configured repository and ambient Git programs across a complete inspection', async () => {
    const root = await repository()
    const sentinelRoot = await mkdtemp(join(tmpdir(), 'saki-config-sentinel-'))
    roots.push(sentinelRoot)
    const script = join(sentinelRoot, 'config-sentinel.mjs')
    const marker = join(sentinelRoot, 'config-ran')
    await writeFile(script, [
      "import { appendFileSync } from 'node:fs'",
      'appendFileSync(process.argv[2], `${process.argv[3]}\\n`)',
      'process.stdin.pipe(process.stdout)',
      '',
    ].join('\n'))
    const command = (label: string): string => [process.execPath, script, marker, label]
      .map(value => `'${value.replaceAll("'", "'\"'\"'")}'`)
      .join(' ')
    await writeFile(join(root, '.gitattributes'), 'tracked.txt diff=saki-sentinel filter=ambient-sentinel\n')
    await git(root, 'add', '.gitattributes')
    await git(root, 'commit', '-m', 'attributes')
    for (const [key, value] of [
      ['core.fsmonitor', 'false'],
      ['core.pager', command('pager')],
      ['pager.status', command('status-pager')],
      ['core.editor', command('editor')],
      ['sequence.editor', command('sequence-editor')],
      ['core.askPass', command('askpass')],
      ['credential.helper', `!${command('credential-helper')}`],
      ['diff.external', command('diff-external')],
      ['diff.saki-sentinel.textconv', command('textconv')],
      ['core.hooksPath', sentinelRoot],
    ] as const) await git(root, 'config', key, value)
    const hook = join(sentinelRoot, 'post-index-change')
    await writeFile(hook, `#!/bin/sh\n${command('hook')}\n`)
    await chmod(hook, 0o755)
    await writeFile(join(root, 'tracked.txt'), 'changed contents\n')
    vi.stubEnv('GIT_CONFIG_COUNT', '3')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.fsmonitor')
    vi.stubEnv('GIT_CONFIG_VALUE_0', command('ambient-fsmonitor'))
    vi.stubEnv('GIT_CONFIG_KEY_1', 'filter.ambient-sentinel.clean')
    vi.stubEnv('GIT_CONFIG_VALUE_1', command('ambient-filter'))
    vi.stubEnv('GIT_CONFIG_KEY_2', 'filter.ambient-sentinel.required')
    vi.stubEnv('GIT_CONFIG_VALUE_2', 'true')
    await expect(readFile(marker)).rejects.toThrow()
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    await expect(readFile(marker)).rejects.toThrow()
    expect(result).toMatchObject({
      ok: true,
      inspection: {
        projection: {
          inheritedChangeEntryCount: 1,
          automaticMutationEligible: false,
          conversionAmbiguous: true,
          blockingReasons: ['dirty', 'conversion-ambiguous'],
          baseline: { kind: 'complete', entries: [{ statusKind: 'tracked' }] },
        },
      },
    })
  }, 15_000)

  it('accepts an explicitly disabled repository fsmonitor', async () => {
    const root = await repository()
    await git(root, 'config', 'core.fsmonitor', 'false')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: true })
  })

  it('rejects repository and worktree config includes before an included fsmonitor can launch', async () => {
    for (const [scope, key] of [
      ['--local', 'include.path'],
      ['--worktree', 'includeIf.onbranch:**.path'],
    ] as const) {
      const root = await repository()
      const script = join(root, 'included-fsmonitor-sentinel.mjs')
      const marker = join(root, 'included-fsmonitor-ran')
      const includedConfig = join(root, 'included-config')
      await writeFile(script, [
        "import { appendFileSync } from 'node:fs'",
        'appendFileSync(process.argv[2], "ran\\n")',
        '',
      ].join('\n'))
      const command = [process.execPath, script, marker]
        .map(value => `'${value.replaceAll("'", "'\"'\"'")}'`)
        .join(' ')
      await git(root, 'config', '--file', includedConfig, 'core.fsmonitor', command)
      if (scope === '--worktree') await git(root, 'config', '--local', 'extensions.worktreeConfig', 'true')
      await git(root, 'config', scope, key, includedConfig.replaceAll('\\', '/'))
      expect(await gitText(root, 'config', '--includes', '--get', 'core.fsmonitor')).toBe(command)
      await expect(readFile(marker)).rejects.toThrow()
      const execution = await provider()

      const result = await execution.inspectProjectSelection(
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      )

      await expect(readFile(marker)).rejects.toThrow()
      expect(result).toEqual({ ok: false, reason: 'unavailable' })
    }
  })

  it('never gives repository-aware Git the source control files before rejecting config includes', async () => {
    const root = await repository()
    const includedConfig = join(root, 'included-config')
    await writeFile(includedConfig, '[core]\n\tbare = true\n')
    await git(root, 'config', '--local', 'include.path', includedConfig.replaceAll('\\', '/'))
    expect(await gitText(root, 'config', '--includes', '--get', 'core.bare')).toBe('true')
    const { fs, git: actual } = await localInspectionHarness()
    const invocations: Array<{ readonly cwd: string; readonly args: readonly string[] }> = []
    const recording = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        invocations.push({ cwd, args: [...args] })
        return await actual.run(cwd, args, signal, stdin, outputBudget)
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      fs,
      { list: () => [] },
      recording,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expectOnlyPrivateRepositoryGit(root, invocations)
  })

  it('runs successful inspection with only private repository control planes', async () => {
    const root = await repository()
    const { fs, git: actual } = await localInspectionHarness()
    const invocations: Array<{ readonly cwd: string; readonly args: readonly string[] }> = []
    const recording = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        invocations.push({ cwd, args: [...args] })
        return await actual.run(cwd, args, signal, stdin, outputBudget)
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      fs,
      { list: () => [] },
      recording,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    expectOnlyPrivateRepositoryGit(root, invocations)
  })

  it('keeps the admitted config bound when the source config changes before repository queries', async () => {
    const root = await repository()
    const includedConfig = join(root, 'late-include')
    await writeFile(includedConfig, '[core]\n\tbare = true\n')
    const sourceConfig = join(root, '.git', 'config')
    const { fs, git: actual } = await localInspectionHarness()
    const invocations: Array<{ readonly cwd: string; readonly args: readonly string[] }> = []
    let replaced = false
    let privateQueriesAfterReplacement = 0
    const recording = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        invocations.push({ cwd, args: [...args] })
        if (replaced && args.some(argument => argument.startsWith('--git-dir='))) {
          privateQueriesAfterReplacement += 1
        }
        const output = await actual.run(cwd, args, signal, stdin, outputBudget)
        if (!replaced && args[0] === 'config' && args.includes('--file')
          && args.includes('--name-only') && args.includes('--list')) {
          const original = await readFile(sourceConfig)
          await writeFile(sourceConfig, Buffer.concat([
            original,
            Buffer.from(`\n[include]\n\tpath = ${includedConfig.replaceAll('\\', '/')}\n`),
          ]))
          replaced = true
        }
        return output
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      fs,
      { list: () => [] },
      recording,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(replaced).toBe(true)
    expect(privateQueriesAfterReplacement).toBeGreaterThan(0)
    expect(result).toEqual({ ok: false, reason: 'ambiguous' })
    expectOnlyPrivateRepositoryGit(root, invocations)
  })

  it.skipIf(process.platform !== 'win32')('rejects UNC, device, and ADS gitfile targets before any Git command', async () => {
    for (const target of [
      '\\\\offline.invalid\\share\\repo',
      '\\\\.\\NUL',
      'C:\\safe\\repo:private',
      'C:\\safe\\NUL\\repo',
      'C:\\safe\\repo. ',
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'saki-hostile-gitfile-'))
      roots.push(root)
      await writeFile(join(root, '.git'), `gitdir: ${target}\n`)
      const { fs, git: actual } = await localInspectionHarness()
      const invocations: Array<{ readonly cwd: string; readonly args: readonly string[] }> = []
      const recording = {
        run: async (
          cwd: string,
          args: readonly string[],
          signal: AbortSignal,
          stdin?: Parameters<GitRunner['run']>[3],
          outputBudget?: Parameters<GitRunner['run']>[4],
        ) => {
          invocations.push({ cwd, args: [...args] })
          return await actual.run(cwd, args, signal, stdin, outputBudget)
        },
      } as GitRunner

      const result = await inspectLocalProjectSelection(
        fs,
        { list: () => [] },
        recording,
        CONFIG,
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      )

      expect(result, target).toEqual({ ok: false, reason: 'unavailable' })
      expect(invocations, target).toEqual([])
    }
  })

  it.skipIf(process.platform !== 'win32')('rejects UNC, device, and ADS locators before any filesystem probe', async () => {
    for (const locator of [
      '\\\\offline.invalid\\share\\repo',
      '\\\\.\\NUL',
      'C:\\safe\\repo:private',
      'C:\\safe\\NUL\\repo',
      'C:\\safe\\repo. ',
    ]) {
      const result = await inspectLocalProjectSelection(
        {} as FileSystem,
        { list: () => [] },
        {} as GitRunner,
        CONFIG,
        { hostId: HOST_ID, directoryLocator: locator },
        new AbortController().signal,
      )

      expect(result, locator).toEqual({ ok: false, reason: 'unavailable' })
    }
  })

  it('rejects a NUL-bearing locator before any filesystem probe on every platform', async () => {
    let probes = 0
    const result = await inspectLocalProjectSelection(
      {
        async lstat() {
          probes += 1
          return undefined
        },
      } as unknown as FileSystem,
      { list: () => [] },
      {} as GitRunner,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: `${parse(process.cwd()).root}repository\0private` },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(probes).toBe(0)
  })

  it('rejects a reparse Git marker before any Git command', async () => {
    const source = await repository()
    const root = await mkdtemp(join(tmpdir(), 'saki-reparse-git-marker-'))
    roots.push(root)
    await symlink(join(source, '.git'), join(root, '.git'), process.platform === 'win32' ? 'junction' : 'dir')
    const { fs, git: actual } = await localInspectionHarness()
    const invocations: Array<{ readonly cwd: string; readonly args: readonly string[] }> = []
    const recording = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        invocations.push({ cwd, args: [...args] })
        return await actual.run(cwd, args, signal, stdin, outputBudget)
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      fs,
      { list: () => [] },
      recording,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(invocations).toEqual([])
  })

  it('rejects a reparse gitfile target before any Git command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-reparse-git-target-'))
    const gitDirectory = `${root}-git`
    const alias = `${root}-git-alias`
    roots.push(root, gitDirectory, alias)
    await mkdir(gitDirectory)
    await symlink(gitDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(root, '.git'), `gitdir: ${alias.replaceAll('\\', '/')}\n`)
    const { fs, git: actual } = await localInspectionHarness()
    let invocations = 0
    const recording = {
      run: async (...args: Parameters<GitRunner['run']>) => {
        invocations += 1
        return await actual.run(...args)
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      fs,
      { list: () => [] },
      recording,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(invocations).toBe(0)
  })

  it('rejects source object alternates before repository-aware Git', async () => {
    const root = await repository()
    const alternates = join(root, '.git', 'objects', 'info', 'alternates')
    await writeFile(alternates, `${join(root, '.git', 'objects').replaceAll('\\', '/')}\n`)
    const { fs, git: actual } = await localInspectionHarness()
    const invocations: Array<{ readonly cwd: string; readonly args: readonly string[] }> = []
    const recording = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        invocations.push({ cwd, args: [...args] })
        return await actual.run(cwd, args, signal, stdin, outputBudget)
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      fs,
      { list: () => [] },
      recording,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(invocations.length).toBeGreaterThan(0)
    expect(invocations.every(invocation =>
      !invocation.args.some(argument => argument.startsWith('--git-dir='))))
      .toBe(true)
  })

  it('ignores repository-configured global attribute and exclude files', async () => {
    const root = await repository()
    const external = await mkdtemp(join(tmpdir(), 'saki-external-git-config-'))
    roots.push(external)
    const attributes = join(external, 'attributes')
    const excludes = join(external, 'excludes')
    await writeFile(attributes, 'tracked.txt filter=external\n')
    await writeFile(excludes, 'outside.txt\n')
    await git(root, 'config', 'core.attributesFile', attributes)
    await git(root, 'config', 'core.excludesFile', excludes)
    await writeFile(join(root, 'outside.txt'), 'untracked\n')
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: true,
      inspection: {
        projection: {
          inheritedChangeEntryCount: 1,
          conversionAmbiguous: false,
          automaticMutationEligible: false,
          blockingReasons: ['dirty'],
          baseline: { kind: 'complete', observed: { entries: 1 } },
        },
      },
    })
  })

  it('does not lazy-fetch a missing promisor object or launch its remote helper', async () => {
    const root = await repository()
    const helperRoot = await mkdtemp(join(tmpdir(), 'saki-promisor-helper-'))
    roots.push(helperRoot)
    const marker = join(helperRoot, 'remote-helper-ran')
    const script = join(helperRoot, 'marker.mjs')
    await writeFile(script, [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      'process.exit(1)',
    ].join('\n'))
    const helper = join(helperRoot, process.platform === 'win32'
      ? 'git-remote-sakimarker.cmd'
      : 'git-remote-sakimarker')
    await writeFile(helper, process.platform === 'win32'
      ? `@node "${script}" %*\r\n`
      : `#!/bin/sh\nexec node '${script}' "$@"\n`)
    if (process.platform !== 'win32') await chmod(helper, 0o755)
    vi.stubEnv('PATH', `${helperRoot}${delimiter}${process.env.PATH ?? ''}`)
    await git(root, 'config', 'core.repositoryformatversion', '1')
    await git(root, 'config', 'extensions.partialClone', 'origin')
    await git(root, 'config', 'remote.origin.promisor', 'true')
    await git(root, 'config', 'remote.origin.partialclonefilter', 'blob:none')
    await git(root, 'config', 'remote.origin.url', 'sakimarker::payload')
    const tree = await gitText(root, 'rev-parse', 'HEAD^{tree}')
    const treePath = join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2))
    await rm(treePath)
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('rejects successful identity and remote commands that write diagnostics', async () => {
    const root = await repository()
    await git(root, 'remote', 'add', 'origin', '../local-repository.git')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(LocalSubprocessRuntime)
    const executable = await ctx.subprocess.resolveExecutable('git')
    const actual = new GitRunner(ctx.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    })
    const selectors = [
      (args: readonly string[]) => {
        const command = gitSubcommand(args)
        return command[0] === 'rev-parse' && command.includes('--show-object-format')
      },
      (args: readonly string[]) => {
        const command = gitSubcommand(args)
        return command[0] === 'config' && command.includes('--get-regexp')
      },
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
          const output = await actual.run(cwd, args, signal, stdin, outputBudget)
          if (injected || !selects(args)) return output
          injected = true
          return { ...output, stderr: Buffer.from('secret diagnostic path') }
        },
      } as GitRunner

      const result = await inspectLocalProjectSelection(
        ctx.fs,
        { list: () => [] },
        diagnostic,
        CONFIG,
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      )

      expect(injected).toBe(true)
      expect(result).toEqual({ ok: false, reason: 'unavailable' })
      expect(JSON.stringify(result)).not.toContain('secret diagnostic path')
    }
  })

  it('rejects a successful nested Git command that writes diagnostics', async () => {
    const source = await repository()
    const root = await repository()
    await addSubmodule(root, source)
    await git(root, 'commit', '-am', 'submodule')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(LocalSubprocessRuntime)
    const executable = await ctx.subprocess.resolveExecutable('git')
    const actual = new GitRunner(ctx.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    })
    let injected = false
    const diagnostic = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        const output = await actual.run(cwd, args, signal, stdin, outputBudget)
        if (injected || !args.includes(`--work-tree=${join(root, 'module')}`)
          || gitSubcommand(args).at(-1) !== 'HEAD^{commit}') return output
        injected = true
        return { ...output, stderr: Buffer.from('nested secret diagnostic') }
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      ctx.fs,
      { list: () => [] },
      diagnostic,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(injected).toBe(true)
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(JSON.stringify(result)).not.toContain('nested secret diagnostic')
  }, 15_000)

  it('rejects missing, non-directory, non-Git, and bare selections safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inspection-reject-'))
    roots.push(root)
    const file = join(root, 'file')
    const ordinary = join(root, 'ordinary')
    const bare = join(root, 'bare.git')
    await writeFile(file, 'x')
    await mkdir(ordinary)
    await mkdir(bare)
    await git(bare, 'init', '--bare')
    const execution = await provider()

    await expect(execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: join(root, 'missing') }, new AbortController().signal))
      .resolves.toEqual({ ok: false, reason: 'missing' })
    await expect(execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: file }, new AbortController().signal))
      .resolves.toEqual({ ok: false, reason: 'not-directory' })
    await expect(execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: ordinary }, new AbortController().signal))
      .resolves.toEqual({ ok: false, reason: 'not-git' })
    await expect(execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: bare }, new AbortController().signal))
      .resolves.toEqual({ ok: false, reason: 'bare' })
  })

  it('contains filesystem-provider diagnostics for an untrusted locator', async () => {
    const secretLocator = 'C:\\private\\customer-secret'
    const filesystem = {
      lstat: () => Promise.reject(new Error(`denied ${secretLocator}`)),
    } as unknown as FileSystem

    const result = await inspectLocalProjectSelection(
      filesystem,
      { list: () => [] },
      {} as GitRunner,
      {
        maxGitStdoutBytes: CONFIG.maxGitStdoutBytes,
        inventoryMaxEntries: CONFIG.inventoryMaxEntries,
        inventoryMaxPathBytes: CONFIG.inventoryMaxPathBytes,
        inventoryMaxGitOutputBytes: CONFIG.inventoryMaxGitOutputBytes,
        inventoryMaxFileBytes: CONFIG.inventoryMaxFileBytes,
        inventoryMaxTotalFileBytes: CONFIG.inventoryMaxTotalFileBytes,
        inventoryMaxCaptureMs: CONFIG.inventoryMaxCaptureMs,
        baselineMaxEntries: CONFIG.baselineMaxEntries,
        baselineMaxPathBytes: CONFIG.baselineMaxPathBytes,
        baselineMaxGitOutputBytes: CONFIG.baselineMaxGitOutputBytes,
        baselineMaxFileBytes: CONFIG.baselineMaxFileBytes,
        baselineMaxTotalFileBytes: CONFIG.baselineMaxTotalFileBytes,
        baselineMaxCaptureMs: CONFIG.baselineMaxCaptureMs,
      },
      { hostId: HOST_ID, directoryLocator: secretLocator },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(JSON.stringify(result)).not.toContain(secretLocator)
  })

  it('includes selected-directory resolution in the observation clock', async () => {
    const locator = 'synthetic-selection'
    const root = join(parse(tmpdir()).root, 'synthetic-repository')
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const result = await inspectLocalProjectSelection(
      syntheticFileSystem(locator, root, {
        lstat(path) {
          if (path === locator) clock = 101
          return { type: 'directory', version: FsVersion('stable') }
        },
      }),
      { list: () => [] },
      { run: () => { throw new Error('Git must not run after the observation expires') } } as unknown as GitRunner,
      { ...CONFIG, inventoryMaxCaptureMs: 100 },
      { hostId: HOST_ID, directoryLocator: locator },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('contains an observation timeout during repository discovery', async () => {
    const root = await repository()
    const harness = await localInspectionHarness()
    let delayed = false
    const filesystem = new Proxy(harness.fs, {
      get(target, property) {
        if (property === 'lstat') {
          return async (...args: Parameters<FileSystem['lstat']>) => {
            if (!delayed && args[0] === join(root, '.git')) {
              delayed = true
              await new Promise(resolve => setTimeout(resolve, 50))
            }
            return await target.lstat(...args)
          }
        }
        const value: unknown = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        const method = value as (...args: unknown[]) => unknown
        return (...args: unknown[]): unknown => method.apply(target, args)
      },
    })

    await expect(inspectLocalProjectSelection(
      filesystem,
      { list: () => [] },
      harness.git,
      { ...CONFIG, inventoryMaxCaptureMs: 5 },
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(delayed).toBe(true)
  })

  it('checks the observation clock after reading the Workspace index', async () => {
    const root = await repository()
    const harness = await localInspectionHarness()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    let reads = 0
    const result = await inspectLocalProjectSelection(
      harness.fs,
      {
        list() {
          reads += 1
          if (reads === 1) clock = 10_001
          return []
        },
      },
      harness.git,
      { ...CONFIG, inventoryMaxCaptureMs: 10_000 },
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(reads).toBe(1)
  })

  it('preserves cancellation and contains provider failure during directory resolution', async () => {
    const secretLocator = 'C:\\private\\resolve-secret'
    const config = {
      maxGitStdoutBytes: CONFIG.maxGitStdoutBytes,
      inventoryMaxEntries: CONFIG.inventoryMaxEntries,
      inventoryMaxPathBytes: CONFIG.inventoryMaxPathBytes,
      inventoryMaxGitOutputBytes: CONFIG.inventoryMaxGitOutputBytes,
      inventoryMaxFileBytes: CONFIG.inventoryMaxFileBytes,
      inventoryMaxTotalFileBytes: CONFIG.inventoryMaxTotalFileBytes,
      inventoryMaxCaptureMs: CONFIG.inventoryMaxCaptureMs,
      baselineMaxEntries: CONFIG.baselineMaxEntries,
      baselineMaxPathBytes: CONFIG.baselineMaxPathBytes,
      baselineMaxGitOutputBytes: CONFIG.baselineMaxGitOutputBytes,
      baselineMaxFileBytes: CONFIG.baselineMaxFileBytes,
      baselineMaxTotalFileBytes: CONFIG.baselineMaxTotalFileBytes,
      baselineMaxCaptureMs: CONFIG.baselineMaxCaptureMs,
    }
    const denied = {
      lstat: async () => ({ type: 'directory' }),
      resolve: async () => { throw new Error(`EACCES ${secretLocator}`) },
    } as unknown as FileSystem

    const unavailable = await inspectLocalProjectSelection(
      denied, { list: () => [] }, {} as GitRunner, config,
      { hostId: HOST_ID, directoryLocator: secretLocator }, new AbortController().signal,
    )

    expect(unavailable).toEqual({ ok: false, reason: 'unavailable' })
    expect(JSON.stringify(unavailable)).not.toContain(secretLocator)

    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    const aborted = {
      lstat: async () => ({ type: 'directory' }),
      resolve: async () => {
        controller.abort(reason)
        throw new Error('provider abort diagnostic')
      },
    } as unknown as FileSystem
    await expect(inspectLocalProjectSelection(
      aborted, { list: () => [] }, {} as GitRunner, config,
      { hostId: HOST_ID, directoryLocator: secretLocator }, controller.signal,
    )).rejects.toBe(reason)
  })

  it('classifies typed disappearance and a second selected-directory identity change as missing', async () => {
    const locator = 'synthetic-selection'
    const root = join(parse(tmpdir()).root, 'synthetic-repository')
    const directory = (): FsInfo => ({ type: 'directory', version: FsVersion('stable') })
    const pathDirectory = (): FsPathInfo => ({ type: 'directory', version: FsVersion('stable') })
    const cases: readonly [string, SyntheticFileSystemOptions][] = [
      ['typed disappearance', {
        lstat: () => pathDirectory(),
        resolve: (path) => {
          if (path === locator) throw new FsError('selection disappeared', 'FS_NOT_FOUND')
          return path
        },
        stat: () => directory(),
      }],
      ['second metadata probe', {
        lstat: () => pathDirectory(),
        stat: (path, occurrence) => path === locator && occurrence === 2
          ? { type: 'file', version: FsVersion('changed') }
          : directory(),
      }],
      ['second canonical path', {
        lstat: () => pathDirectory(),
        resolve: (path, occurrence) => path === locator
          ? occurrence === 1 ? root : `${root}-moved`
          : path,
        stat: () => directory(),
      }],
    ]

    for (const [name, options] of cases) {
      const result = await inspectLocalProjectSelection(
        syntheticFileSystem(locator, root, options),
        { list: () => [] },
        {} as GitRunner,
        CONFIG,
        { hostId: HOST_ID, directoryLocator: locator },
        new AbortController().signal,
      )
      expect(result, name).toEqual({ ok: false, reason: 'missing' })
    }
  })

  it('aborts and drains an active inspection when its provider is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountLocalHostOperationStorage(ctx, roots)
    const started = Promise.withResolvers<undefined>()
    const settled = Promise.withResolvers<undefined>()
    let didSettle = false
    ctx.provide('fs', {
      lstat: (_path: string, _options: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
        started.resolve(undefined)
        signal.addEventListener('abort', () => {
          setTimeout(() => {
            didSettle = true
            settled.resolve(undefined)
            reject(signal.reason instanceof Error ? signal.reason : new Error('inspection aborted'))
          }, 20)
        }, { once: true })
      }),
    } as never)
    await ctx.plugin(LocalSubprocessRuntime)
    ctx.provide('workspaceRegistry', { list: () => [] })
    const fiber = await ctx.plugin(LocalSakiHostExecution, CONFIG)
    const retained = ctx.sakiHostExecution as LocalSakiHostExecution
    const pending = retained.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: 'C:\\pending' },
      new AbortController().signal,
    )
    await started.promise

    const disposal = fiber.dispose()
    await Promise.resolve()
    expect(didSettle).toBe(false)
    await disposal

    expect(didSettle).toBe(true)
    await settled.promise
    await expect(pending).rejects.toThrow('Saki Local Host Execution disposed')
    await expect(retained.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: 'C:\\after-dispose' },
      new AbortController().signal,
    )).rejects.toThrow('Saki Local Host Execution disposed')
  })

  it('rejects a checkout race instead of publishing a mixed inspection', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'second\n')
    await git(root, 'add', 'tracked.txt')
    await git(root, 'commit', '-m', 'second')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(LocalSubprocessRuntime)
    const executable = await ctx.subprocess.resolveExecutable('git')
    const actual = new GitRunner(ctx.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    })
    let changed = false
    const racing = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        const output = await actual.run(cwd, args, signal, stdin, outputBudget)
        const command = gitSubcommand(args)
        if (!changed && command[0] === 'rev-parse' && command.at(-1) === '--show-object-format') {
          changed = true
          await git(root, 'checkout', '--detach', 'HEAD~1')
        }
        return output
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      ctx.fs,
      { list: () => [] },
      racing,
      {
        maxGitStdoutBytes: CONFIG.maxGitStdoutBytes,
        inventoryMaxEntries: CONFIG.inventoryMaxEntries,
        inventoryMaxPathBytes: CONFIG.inventoryMaxPathBytes,
        inventoryMaxGitOutputBytes: CONFIG.inventoryMaxGitOutputBytes,
        inventoryMaxFileBytes: CONFIG.inventoryMaxFileBytes,
        inventoryMaxTotalFileBytes: CONFIG.inventoryMaxTotalFileBytes,
        inventoryMaxCaptureMs: CONFIG.inventoryMaxCaptureMs,
        baselineMaxEntries: CONFIG.baselineMaxEntries,
        baselineMaxPathBytes: CONFIG.baselineMaxPathBytes,
        baselineMaxGitOutputBytes: CONFIG.baselineMaxGitOutputBytes,
        baselineMaxFileBytes: CONFIG.baselineMaxFileBytes,
        baselineMaxTotalFileBytes: CONFIG.baselineMaxTotalFileBytes,
        baselineMaxCaptureMs: CONFIG.baselineMaxCaptureMs,
      },
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'ambiguous' })
    expect(changed).toBe(true)
  })

  it('classifies a complete repository identity change between observations as ambiguous', async () => {
    const root = await repository()
    const harness = await localInspectionHarness()
    let identityReads = 0

    const result = await inspectLocalProjectSelection(
      harness.fs,
      { list: () => [] },
      harness.git,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
      async () => ({
        version: 1,
        digest: (++identityReads === 1 ? '1' : '2').repeat(64),
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'ambiguous' })
    expect(identityReads).toBe(2)
  })

  it('keeps native administrative identity stable for child writes and changes it for directory replacement', async () => {
    const root = await repository()
    const gitDirectory = join(root, '.git')
    const replacement = `${root}-replacement-git`
    const displaced = `${root}-displaced-git`
    roots.push(replacement, displaced)
    const execution = await provider()

    const first = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )
    expect(first.ok, JSON.stringify(first)).toBe(true)
    if (!first.ok) return

    await writeFile(join(gitDirectory, 'ordinary-child'), 'ordinary administrative child\n')
    const afterChildWrite = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )
    expect(afterChildWrite.ok, JSON.stringify(afterChildWrite)).toBe(true)
    if (!afterChildWrite.ok) return
    expect(afterChildWrite.inspection.trusted.gitDirectoryIdentity)
      .toEqual(first.inspection.trusted.gitDirectoryIdentity)
    expect(afterChildWrite.inspection.trusted.commonGitDirectoryIdentity)
      .toEqual(first.inspection.trusted.commonGitDirectoryIdentity)

    await cp(gitDirectory, replacement, { recursive: true })
    await rename(gitDirectory, displaced)
    await rename(replacement, gitDirectory)
    const afterReplacement = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )
    expect(afterReplacement.ok, JSON.stringify(afterReplacement)).toBe(true)
    if (!afterReplacement.ok) return
    expect(afterReplacement.inspection.trusted.canonicalGitDirectory)
      .toBe(first.inspection.trusted.canonicalGitDirectory)
    expect(afterReplacement.inspection.trusted.canonicalCommonGitDirectory)
      .toBe(first.inspection.trusted.canonicalCommonGitDirectory)
    expect(afterReplacement.inspection.trusted.gitDirectoryIdentity)
      .not.toEqual(first.inspection.trusted.gitDirectoryIdentity)
    expect(afterReplacement.inspection.trusted.commonGitDirectoryIdentity)
      .not.toEqual(first.inspection.trusted.commonGitDirectoryIdentity)
  }, 30_000)

  it('classifies failed independent final repository admissions by owned failure kind', async () => {
    const finalAdmissionDiscoveryRead = 7
    const finalAdmissionGitDirectoryRead = 8
    for (const [finalKind, reason] of [
      ['malformed', 'malformed'],
      ['unavailable', 'unavailable'],
      ['not-git', 'ambiguous'],
    ] as const) {
      const root = await repository()
      const harness = await localInspectionHarness()
      const markerPath = normalize(join(root, '.git'))
      let markerReads = 0
      const filesystem = new Proxy(harness.fs, {
        get(target, property) {
          if (property === 'lstat') {
            return async (...args: Parameters<FileSystem['lstat']>) => {
              const actual = await target.lstat(...args)
              if (normalize(args[0]) !== markerPath) return actual
              markerReads += 1
              if (markerReads === finalAdmissionDiscoveryRead && finalKind === 'not-git') return undefined
              if (markerReads === finalAdmissionDiscoveryRead && finalKind === 'unavailable' && actual !== undefined) {
                return { ...actual, type: 'symlink' as const }
              }
              if (markerReads === finalAdmissionGitDirectoryRead && finalKind === 'malformed') return undefined
              return actual
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          if (typeof value !== 'function') return value
          const method = value as (...args: unknown[]) => unknown
          return (...args: unknown[]): unknown => method.apply(target, args)
        },
      })

      const result = await inspectLocalProjectSelection(
        filesystem,
        { list: () => [] },
        harness.git,
        CONFIG,
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      )

      expect(markerReads).toBe(finalKind === 'malformed'
        ? finalAdmissionGitDirectoryRead
        : finalAdmissionDiscoveryRead)
      expect(result, finalKind).toEqual({ ok: false, reason })
    }
  }, 30_000)

  it('classifies malformed facts in the final observation before comparing snapshots', async () => {
    const root = await repository()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(LocalSubprocessRuntime)
    const executable = await ctx.subprocess.resolveExecutable('git')
    const actual = new GitRunner(ctx.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    })

    for (const corrupt of ['object-format', 'head'] as const) {
      let matchingReads = 0
      const malformed = {
        run: async (
          cwd: string,
          args: readonly string[],
          signal: AbortSignal,
          stdin?: Parameters<GitRunner['run']>[3],
          outputBudget?: Parameters<GitRunner['run']>[4],
        ) => {
          const output = await actual.run(cwd, args, signal, stdin, outputBudget)
          const command = gitSubcommand(args)
          const matches = command[0] === 'rev-parse'
            && command.at(-1) === (corrupt === 'object-format' ? '--show-object-format' : 'HEAD')
          if (!matches || ++matchingReads !== 2) return output
          if (corrupt === 'object-format') return { ...output, stdout: Buffer.from('sha512\n') }
          return { ...output, stdout: Buffer.from(`${'0'.repeat(40)}\n`) }
        },
      } as GitRunner

      await expect(inspectLocalProjectSelection(
        ctx.fs,
        { list: () => [] },
        malformed,
        CONFIG,
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      )).resolves.toEqual({ ok: false, reason: 'malformed' })
    }
  }, 30_000)

  it('rejects a Workspace identity change between the two observations', async () => {
    const root = await repository()
    const canonical = await realpath(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(LocalSubprocessRuntime)
    const executable = await ctx.subprocess.resolveExecutable('git')
    const actual = new GitRunner(ctx.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    })
    let reads = 0

    const result = await inspectLocalProjectSelection(
      ctx.fs,
      {
        list: () => [{ id: WorkspaceId(reads++ === 0 ? 'workspace-a' : 'workspace-b'), path: canonical }],
      },
      actual,
      {
        maxGitStdoutBytes: CONFIG.maxGitStdoutBytes,
        inventoryMaxEntries: CONFIG.inventoryMaxEntries,
        inventoryMaxPathBytes: CONFIG.inventoryMaxPathBytes,
        inventoryMaxGitOutputBytes: CONFIG.inventoryMaxGitOutputBytes,
        inventoryMaxFileBytes: CONFIG.inventoryMaxFileBytes,
        inventoryMaxTotalFileBytes: CONFIG.inventoryMaxTotalFileBytes,
        inventoryMaxCaptureMs: CONFIG.inventoryMaxCaptureMs,
        baselineMaxEntries: CONFIG.baselineMaxEntries,
        baselineMaxPathBytes: CONFIG.baselineMaxPathBytes,
        baselineMaxGitOutputBytes: CONFIG.baselineMaxGitOutputBytes,
        baselineMaxFileBytes: CONFIG.baselineMaxFileBytes,
        baselineMaxTotalFileBytes: CONFIG.baselineMaxTotalFileBytes,
        baselineMaxCaptureMs: CONFIG.baselineMaxCaptureMs,
      },
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'ambiguous' })
    expect(reads).toBe(2)
  })

  it('classifies invalid branch, upstream, and HEAD values as closed Git evidence failures', async () => {
    const root = await repository()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(LocalSubprocessRuntime)
    const executable = await ctx.subprocess.resolveExecutable('git')
    const actual = new GitRunner(ctx.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    })

    for (const [corrupt, expected] of [
      ['branch', 'malformed'],
      ['upstream', 'malformed'],
      ['upstream-prefix', 'malformed'],
      ['upstream-short-control', 'malformed'],
      ['overlong-branch', 'unavailable'],
      ['overlong-upstream', 'unavailable'],
      ['overlong-upstream-short', 'unavailable'],
      ['zero-head', 'malformed'],
    ] as const) {
      let upstreamQueries = 0
      const malformed = {
        run: async (
          cwd: string,
          args: readonly string[],
          signal: AbortSignal,
          stdin?: Parameters<GitRunner['run']>[3],
          outputBudget?: Parameters<GitRunner['run']>[4],
        ) => {
          const output = await actual.run(cwd, args, signal, stdin, outputBudget)
          const command = gitSubcommand(args)
          if (corrupt === 'zero-head' && command[0] === 'rev-parse' && command.at(-1) === 'HEAD') {
            return { ...output, stdout: Buffer.from(`${'0'.repeat(40)}\n`) }
          }
          if ((corrupt === 'branch' || corrupt === 'overlong-branch') && command[0] === 'symbolic-ref') {
            const ref = corrupt === 'branch' ? 'refs/heads/bad.lock' : `refs/heads/${'a'.repeat(MAX_GIT_REF_CHARS)}`
            return { ...output, stdout: Buffer.from(`${ref}\n`) }
          }
          if ((corrupt === 'upstream' || corrupt === 'upstream-prefix'
            || corrupt === 'upstream-short-control' || corrupt === 'overlong-upstream'
            || corrupt === 'overlong-upstream-short') && command[0] === 'for-each-ref') {
            if (++upstreamQueries !== 2) return output
            const ref = command.at(-1)
            if (ref === undefined) throw new Error('missing exact branch ref')
            const upstream = corrupt === 'upstream'
              ? 'refs/remotes/origin/bad.lock'
              : corrupt === 'upstream-prefix'
                ? 'origin/main'
                : corrupt === 'overlong-upstream'
                  ? `refs/remotes/origin/${'a'.repeat(MAX_GIT_REF_CHARS)}`
                  : 'refs/remotes/origin/main'
            const upstreamShort = corrupt === 'upstream'
              ? 'origin/bad.lock'
              : corrupt === 'upstream-short-control'
                ? 'origin/\tmain'
                : corrupt === 'overlong-upstream' || corrupt === 'overlong-upstream-short'
                  ? `origin/${'a'.repeat(MAX_GIT_REF_CHARS)}`
                  : 'origin/main'
            return { ...output, stdout: Buffer.from(`${ref}\0${upstream}\0${upstreamShort}\0\n`) }
          }
          return output
        },
      } as GitRunner

      await expect(inspectLocalProjectSelection(
        ctx.fs,
        { list: () => [] },
        malformed,
        CONFIG,
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      ), corrupt).resolves.toEqual({ ok: false, reason: expected })
    }
  }, 30_000)

  it('rejects a valid Git branch that disagrees with either admitted source-control snapshot', async () => {
    for (const mismatchAt of [1, 2]) {
      const root = await repository()
      const harness = await localInspectionHarness()
      let branchReads = 0
      const mismatched = {
        run: async (
          cwd: string,
          args: readonly string[],
          signal: AbortSignal,
          stdin?: Parameters<GitRunner['run']>[3],
          outputBudget?: Parameters<GitRunner['run']>[4],
        ) => {
          const output = await harness.git.run(cwd, args, signal, stdin, outputBudget)
          const command = gitSubcommand(args)
          if (command[0] === 'for-each-ref' && command.at(-1) === 'refs/heads/other') {
            return { ...output, stdout: Buffer.from('refs/heads/other\0\0\0\n') }
          }
          if (command[0] !== 'symbolic-ref' || ++branchReads !== mismatchAt) return output
          return { ...output, stdout: Buffer.from('refs/heads/other\n') }
        },
      } as GitRunner

      const result = await inspectLocalProjectSelection(
        harness.fs,
        { list: () => [] },
        mismatched,
        CONFIG,
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      )

      expect(result, `observation ${mismatchAt}`).toEqual({ ok: false, reason: 'ambiguous' })
      expect(branchReads).toBe(mismatchAt)
    }
  })

  it('classifies nested repository identity failures without trusting its administrative paths', async () => {
    const source = await repository()
    const root = await repository()
    await addSubmodule(root, source)
    await git(root, 'commit', '-am', 'submodule')
    const module = join(root, 'module')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(LocalSubprocessRuntime)
    const executable = await ctx.subprocess.resolveExecutable('git')
    const actual = new GitRunner(ctx.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    })
    for (const [corrupt, expected] of [
      ['object-format', 'malformed'],
      ['object-format-utf8', 'malformed'],
      ['zero-object', 'malformed'],
      ['different-object-format', 'blocked'],
    ] as const) {
      const nested = {
        run: async (
          cwd: string,
          args: readonly string[],
          signal: AbortSignal,
          stdin?: Parameters<GitRunner['run']>[3],
          outputBudget?: Parameters<GitRunner['run']>[4],
        ) => {
          const output = await actual.run(cwd, args, signal, stdin, outputBudget)
          const command = gitSubcommand(args)
          const nestedContext = args.includes(`--work-tree=${module}`)
          if (nestedContext && corrupt === 'object-format' && command.includes('--show-object-format')) {
            return { ...output, stdout: Buffer.from('sha512\n') }
          }
          if (nestedContext && corrupt === 'object-format-utf8' && command.includes('--show-object-format')) {
            return { ...output, stdout: Buffer.from([0xff]) }
          }
          if (nestedContext && corrupt === 'different-object-format' && command.includes('--show-object-format')) {
            return { ...output, stdout: Buffer.from('sha256\n') }
          }
          if (nestedContext && corrupt === 'different-object-format' && command.at(-1) === 'HEAD^{commit}') {
            return { ...output, stdout: Buffer.from(`${'1'.repeat(64)}\n`) }
          }
          if (nestedContext && corrupt === 'zero-object' && command.at(-1) === 'HEAD^{commit}') {
            return { ...output, stdout: Buffer.from(`${'0'.repeat(40)}\n`) }
          }
          return output
        },
      } as GitRunner

      const result = await inspectLocalProjectSelection(
        ctx.fs,
        { list: () => [] },
        nested,
        CONFIG,
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      )

      if (expected === 'malformed') {
        expect(result, corrupt).toEqual({ ok: false, reason: 'malformed' })
      } else {
        expect(result, corrupt).toMatchObject({
          ok: true,
          inspection: {
            projection: {
              automaticMutationEligible: false,
              blockingReasons: ['dirty', 'baseline-unavailable'],
              baseline: { kind: 'unavailable', reason: 'unsupported-state' },
            },
          },
        })
      }
    }
  }, 30_000)

  it('ignores replacement refs when comparing HEAD, index, and worktree bytes', async () => {
    const root = await repository()
    const original = await gitText(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, 'tracked.txt'), 'replacement\n')
    await git(root, 'add', 'tracked.txt')
    await git(root, 'commit', '-m', 'replacement tree')
    const replacement = await gitText(root, 'rev-parse', 'HEAD')
    await git(root, 'reset', '--soft', original)
    await git(root, 'replace', original, replacement)
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection).toMatchObject({
      head: { kind: 'commit', objectId: original },
      inheritedChangeEntryCount: 1,
      automaticMutationEligible: false,
      blockingReasons: ['dirty'],
      baseline: { kind: 'complete' },
    })
  })

  it.skipIf(process.platform !== 'win32')('keeps an indexed NTFS alternate data stream out of ordinary path evidence', async () => {
    const root = await repository()
    const payload = join(root, 'payload.tmp')
    await writeFile(payload, 'stream content\n')
    const objectId = await gitText(root, 'hash-object', '-w', 'payload.tmp')
    await rm(payload)
    await writeFile(join(root, 'tracked.txt:secret'), 'stream content\n')
    await git(root, '-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${objectId},tracked.txt:secret`)
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inspection.projection).toMatchObject({
      inheritedChangeEntryCount: 1,
      automaticMutationEligible: false,
      blockingReasons: ['dirty', 'baseline-unavailable'],
      baseline: { kind: 'unavailable', reason: 'unsupported-state' },
    })
  })

  it('rejects index objects whose width disagrees with the repository object format', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'changed contents\n')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(LocalSubprocessRuntime)
    const executable = await ctx.subprocess.resolveExecutable('git')
    const actual = new GitRunner(ctx.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    })
    const mismatched = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
      ) => {
        const output = await actual.run(cwd, args, signal, stdin)
        const command = gitSubcommand(args)
        if (command[0] !== 'ls-files' || !command.includes('--stage')) return output
        return {
          ...output,
          stdout: Buffer.from(output.stdout.toString('utf8').replace(/[0-9a-f]{40}/u, 'a'.repeat(64))),
        }
      },
    } as GitRunner

    const result = await inspectLocalProjectSelection(
      ctx.fs,
      { list: () => [] },
      mismatched,
      {
        maxGitStdoutBytes: CONFIG.maxGitStdoutBytes,
        inventoryMaxEntries: CONFIG.inventoryMaxEntries,
        inventoryMaxPathBytes: CONFIG.inventoryMaxPathBytes,
        inventoryMaxGitOutputBytes: CONFIG.inventoryMaxGitOutputBytes,
        inventoryMaxFileBytes: CONFIG.inventoryMaxFileBytes,
        inventoryMaxTotalFileBytes: CONFIG.inventoryMaxTotalFileBytes,
        inventoryMaxCaptureMs: CONFIG.inventoryMaxCaptureMs,
        baselineMaxEntries: CONFIG.baselineMaxEntries,
        baselineMaxPathBytes: CONFIG.baselineMaxPathBytes,
        baselineMaxGitOutputBytes: CONFIG.baselineMaxGitOutputBytes,
        baselineMaxFileBytes: CONFIG.baselineMaxFileBytes,
        baselineMaxTotalFileBytes: CONFIG.baselineMaxTotalFileBytes,
        baselineMaxCaptureMs: CONFIG.baselineMaxCaptureMs,
      },
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('closes malformed and failed first-round Git observations by category', async () => {
    const root = await repository()
    const harness = await localInspectionHarness()
    for (const [corrupt, expected] of [
      ['object-format', 'malformed'],
      ['head-width', 'malformed'],
      ['head-timeout', 'unavailable'],
      ['detached-unborn', 'malformed'],
      ['branch-timeout', 'unavailable'],
      ['branch-namespace', 'malformed'],
      ['upstream-utf8', 'malformed'],
      ['upstream-mismatch', 'malformed'],
      ['upstream-frame', 'malformed'],
      ['upstream-partial', 'malformed'],
      ['status-malformed', 'malformed'],
      ['remote-record', 'malformed'],
      ['remote-empty', 'malformed'],
      ['remote-partial', 'malformed'],
      ['remote-utf8', 'malformed'],
      ['text-utf8', 'malformed'],
      ['text-no-newline', 'malformed'],
      ['text-multiline', 'malformed'],
    ] as const) {
      let upstreamQueries = 0
      const injected = {
        run: async (
          cwd: string,
          args: readonly string[],
          signal: AbortSignal,
          stdin?: Parameters<GitRunner['run']>[3],
          outputBudget?: Parameters<GitRunner['run']>[4],
        ) => {
          const command = gitSubcommand(args)
          if (corrupt === 'branch-timeout' && command[0] === 'symbolic-ref') {
            throw new GitCommandError('timeout')
          }
          if (corrupt === 'head-timeout' && command[0] === 'rev-parse' && command.at(-1) === 'HEAD') {
            throw new GitCommandError('timeout')
          }
          if (corrupt === 'detached-unborn' && command[0] === 'symbolic-ref') {
            throw new GitCommandError('nonzero', 1)
          }
          if (corrupt === 'detached-unborn' && command[0] === 'rev-parse' && command.at(-1) === 'HEAD') {
            throw new GitCommandError('nonzero', 128)
          }
          if (corrupt === 'status-malformed' && args.includes('status')) {
            return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
          }
          if (command[0] === 'config' && command.includes('--get-regexp')) {
            if (corrupt === 'remote-record') return { stdout: Buffer.from('remote.origin.url\0'), stderr: Buffer.alloc(0) }
            if (corrupt === 'remote-empty') {
              return { stdout: Buffer.from('remote.origin.url\nhttps://example.com/repo\0\0'), stderr: Buffer.alloc(0) }
            }
            if (corrupt === 'remote-partial') {
              return { stdout: Buffer.from('remote.origin.url\nhttps://example.com/repo'), stderr: Buffer.alloc(0) }
            }
            if (corrupt === 'remote-utf8') {
              return {
                stdout: Buffer.concat([Buffer.from('remote.origin.url\n'), Buffer.from([0xff, 0])]),
                stderr: Buffer.alloc(0),
              }
            }
          }
          const output = await harness.git.run(cwd, args, signal, stdin, outputBudget)
          if (command[0] === 'rev-parse' && command.at(-1) === '--show-object-format') {
            if (corrupt === 'text-utf8') return { ...output, stdout: Buffer.from([0xff]) }
            if (corrupt === 'text-no-newline') return { ...output, stdout: Buffer.from('sha1') }
            if (corrupt === 'text-multiline') return { ...output, stdout: Buffer.from('sha1\nextra\n') }
            if (corrupt === 'object-format') return { ...output, stdout: Buffer.from('sha512\n') }
          }
          if (corrupt === 'head-width' && command[0] === 'rev-parse' && command.at(-1) === 'HEAD') {
            return { ...output, stdout: Buffer.from(`${'1'.repeat(39)}\n`) }
          }
          if (corrupt === 'branch-namespace' && command[0] === 'symbolic-ref') {
            return { ...output, stdout: Buffer.from('refs/tags/main\n') }
          }
          if (command[0] === 'for-each-ref') {
            if (++upstreamQueries !== 2) return output
            if (corrupt === 'upstream-utf8') return { ...output, stdout: Buffer.from([0xff]) }
            if (corrupt === 'upstream-mismatch') {
              return { ...output, stdout: Buffer.from('refs/heads/other\0\0\0\n') }
            }
            if (corrupt === 'upstream-frame') {
              return { ...output, stdout: Buffer.from('refs/heads/main\0\0\0') }
            }
            if (corrupt === 'upstream-partial') {
              return { ...output, stdout: Buffer.from('refs/heads/main\0refs/remotes/origin/main\0\0\n') }
            }
          }
          return output
        },
      } as GitRunner

      const result = await inspectLocalProjectSelection(
        harness.fs,
        { list: () => [] },
        injected,
        CONFIG,
        { hostId: HOST_ID, directoryLocator: root },
        new AbortController().signal,
      )
      expect(result, corrupt).toEqual({ ok: false, reason: expected })
    }
  }, 30_000)

  it('retains real linked-worktree lock and upstream observations', async () => {
    const root = await repository()
    const linked = `${root}-locked`
    roots.push(linked)
    await git(root, 'config', 'core.autocrlf', 'false')
    await git(root, 'remote', 'add', 'origin', '../origin.git')
    await git(root, 'worktree', 'add', '-b', 'linked-branch', linked)
    await git(linked, 'config', 'branch.linked-branch.remote', 'origin')
    await git(linked, 'config', 'branch.linked-branch.merge', 'refs/heads/main')
    await git(root, 'worktree', 'lock', linked)
    const execution = await provider()

    const result = await execution.inspectProjectSelection(
      { hostId: HOST_ID, directoryLocator: linked },
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: true,
      inspection: {
        projection: {
          upstream: 'refs/remotes/origin/main',
          locked: true,
          inheritedChangeEntryCount: 0,
          baseline: { kind: 'complete', entries: [] },
          automaticMutationEligible: false,
          blockingReasons: ['locked'],
        },
      },
    })
  })

  it('accepts CRLF from repository Git text', async () => {
    const root = await repository()
    const harness = await localInspectionHarness()
    const crlf = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        const output = await harness.git.run(cwd, args, signal, stdin, outputBudget)
        const command = gitSubcommand(args)
        if (command[0] === 'rev-parse' && command.at(-1) === '--show-object-format') {
          return { ...output, stdout: Buffer.from('sha1\r\n') }
        }
        return output
      },
    } as GitRunner
    const result = await inspectLocalProjectSelection(
      harness.fs,
      { list: () => [] },
      crlf,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: true, inspection: { projection: { objectFormat: 'sha1' } } })
  })

  it('preserves cancellation raised by the first Git observation', async () => {
    const root = await repository()
    const harness = await localInspectionHarness()
    const controller = new AbortController()
    const reason = new Error('caller cancelled during Git')
    const aborting = {
      run: async () => {
        controller.abort(reason)
        throw new GitCommandError('aborted')
      },
    } as unknown as GitRunner

    await expect(inspectLocalProjectSelection(
      harness.fs,
      { list: () => [] },
      aborting,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      controller.signal,
    )).rejects.toBe(reason)
  })

  it('rejects duplicate Workspace ownership without exposing registry details', async () => {
    const root = await repository()
    const canonical = await realpath(root)
    const harness = await localInspectionHarness()
    const result = await inspectLocalProjectSelection(
      harness.fs,
      { list: () => [
        { id: WorkspaceId('workspace-one'), path: canonical },
        { id: WorkspaceId('workspace-two'), path: canonical },
      ] },
      harness.git,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('rejects an overlong canonical selected directory before Git', async () => {
    const locator = 'synthetic-selection'
    const root = join(parse(tmpdir()).root, 'synthetic-repository')
    const longRoot = join(root, 'x'.repeat(MAX_TRUSTED_PATH_CHARS + 1))
    let gitRuns = 0
    const result = await inspectLocalProjectSelection(
      syntheticFileSystem(locator, longRoot),
      { list: () => [] },
      { run: () => { gitRuns += 1; throw new Error('overlong selection reached Git') } } as unknown as GitRunner,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: locator },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(gitRuns).toBe(0)
  })

  it('rejects a baseline completeness class that changes between observations', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'changed contents\n')
    const harness = await localInspectionHarness()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    let attributeReads = 0
    const changing = {
      run: async (
        cwd: string,
        args: readonly string[],
        signal: AbortSignal,
        stdin?: Parameters<GitRunner['run']>[3],
        outputBudget?: Parameters<GitRunner['run']>[4],
      ) => {
        const command = gitSubcommand(args)
        if (command[0] === 'check-attr' && ++attributeReads === 2) clock = 5_001
        return await harness.git.run(cwd, args, signal, stdin, outputBudget)
      },
    } as GitRunner
    const result = await inspectLocalProjectSelection(
      harness.fs,
      { list: () => [] },
      changing,
      { ...CONFIG, inventoryMaxCaptureMs: 10_000, baselineMaxCaptureMs: 5_000 },
      { hostId: HOST_ID, directoryLocator: root },
      new AbortController().signal,
    )

    expect(result).toEqual({ ok: false, reason: 'ambiguous' })
    expect(attributeReads).toBe(2)
  })
})
