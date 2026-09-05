import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  canonicalDigest,
  type ActiveHostProjectBinding,
  type SakiHostId,
  type SakiResourceBindingId,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeGitLine, inspectLocalProjectCommit, type LocalCommitInspectionDependencies } from '../src/commit-inspection.ts'
import { GitCommandError, GitRunner, gitInspectionEnvironment } from '../src/git-runner.ts'
import { inspectLocalProjectSelection, type InspectionConfig } from '../src/inspection.ts'

const run = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const limits: InspectionConfig = {
  maxGitStdoutBytes: 1_000_000,
  inventoryMaxEntries: 100,
  inventoryMaxPathBytes: 10_000,
  inventoryMaxGitOutputBytes: 100_000,
  inventoryMaxFileBytes: 100_000,
  inventoryMaxTotalFileBytes: 1_000_000,
  inventoryMaxCaptureMs: 10_000,
  baselineMaxEntries: 100,
  baselineMaxPathBytes: 10_000,
  baselineMaxGitOutputBytes: 100_000,
  baselineMaxFileBytes: 100_000,
  baselineMaxTotalFileBytes: 1_000_000,
  baselineMaxCaptureMs: 10_000,
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

async function fixture() {
  const allocated = await mkdtemp(join(tmpdir(), 'saki-commit-inspection-'))
  roots.push(allocated)
  const root = await realpath(allocated)
  const git = async (...args: string[]) => (await run('git', args, {
    cwd: root, windowsHide: true, env: { ...process.env, ...gitInspectionEnvironment() },
  })).stdout.trim()
  await git('init', '--initial-branch=main')
  await git('-c', 'user.name=Saki Test', '-c', 'user.email=saki@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'inspection fixture')
  const commitId = await git('rev-parse', 'HEAD')
  const context = new Context()
  contexts.push(context)
  await context.plugin(LocalFileSystem, { cwd: root })
  await context.plugin(LocalSubprocessRuntime)
  const executable = await context.subprocess.resolveExecutable('git')
  const workspaceId = WorkspaceId('commit-inspection-workspace')
  const workspaces = [{ id: workspaceId, path: root }]
  const dependencies: LocalCommitInspectionDependencies = {
    fs: context.fs,
    git: new GitRunner(context.subprocess, executable, {
      maxStdoutBytes: limits.maxGitStdoutBytes, maxStderrBytes: 64_000, timeoutMs: 10_000, terminationGraceMs: 100,
    }),
    config: limits,
    workspaces: { list: () => workspaces },
    identityReader: async (path, signal) => {
      signal.throwIfAborted()
      const identity = await lstat(path, { bigint: true })
      return { version: 1, digest: canonicalDigest('saki/test-directory-identity/v1', {
        device: String(identity.dev), inode: String(identity.ino), created: String(identity.birthtimeNs),
      }) }
    },
  }
  const signal = new AbortController().signal
  const hostId = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
  const selected = await inspectLocalProjectSelection(
    dependencies.fs, dependencies.workspaces, dependencies.git, limits,
    { hostId, directoryLocator: root }, signal, dependencies.identityReader,
  )
  if (!selected.ok) throw new Error(`Commit fixture selection failed: ${JSON.stringify(selected)}`)
  const binding: ActiveHostProjectBinding = {
    id: 'binding-11111111-1111-4111-8111-111111111111' as SakiResourceBindingId,
    revision: 0, health: 'active', hostId, workspaceId,
    expectedInspection: selected.inspection,
    inheritedChangeBaseline: selected.inspection.projection.baseline,
  }
  return { root, dependencies, binding, commitId, workspaces, signal }
}

describe('exact Commit process output', () => {
  it.each([
    { name: 'LF', bytes: Buffer.from('abc\n'), expected: 'abc' },
    { name: 'CRLF', bytes: Buffer.from('abc\r\n'), expected: 'abc' },
    { name: 'missing terminator', bytes: Buffer.from('abc'), expected: undefined },
    { name: 'multiple lines', bytes: Buffer.from('abc\ndef\n'), expected: undefined },
    { name: 'invalid UTF-8', bytes: Buffer.from([0xff]), expected: undefined },
  ])('decodes $name without accepting trailing process output', ({ bytes, expected }) => {
    expect(decodeGitLine(bytes)).toBe(expected)
  })
})

describe('bound local Commit inspection', () => {
  let test: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { test = await fixture() })

  it('confirms an exact Commit and distinguishes a missing object', async () => {
    expect(await inspectLocalProjectCommit(test.dependencies, test.binding, test.commitId, test.signal))
      .toEqual({ ok: true, commitId: test.commitId })
    expect(await inspectLocalProjectCommit(test.dependencies, test.binding, 'f'.repeat(40), test.signal))
      .toEqual({ ok: false, reason: 'commit-missing' })
  })

  it.each(['stderr', 'different object', 'malformed output'] as const)('rejects rev-parse %s', async (fault) => {
    const original = test.dependencies.git.run.bind(test.dependencies.git)
    vi.spyOn(test.dependencies.git, 'run').mockImplementation(async (cwd, args, ...rest) => {
      const output = await original(cwd, args, ...rest)
      if (args.at(-1) !== `${test.commitId}^{commit}`) return output
      return fault === 'stderr'
        ? { ...output, stderr: Buffer.from('object database warning\n') }
        : { ...output, stdout: Buffer.from(fault === 'different object' ? `${'f'.repeat(40)}\n` : 'invalid\nextra\n') }
    })
    expect(await inspectLocalProjectCommit(test.dependencies, test.binding, test.commitId, test.signal))
      .toEqual({ ok: false, reason: 'unavailable' })
  })

  it.each(['nonzero', 'timeout', 'filesystem'] as const)('classifies %s failure during Commit verification', async (fault) => {
    const original = test.dependencies.git.run.bind(test.dependencies.git)
    vi.spyOn(test.dependencies.git, 'run').mockImplementation(async (cwd, args, ...rest) => {
      if (args.at(-1) === `${test.commitId}^{commit}`) {
        if (fault === 'filesystem') await writeFile(join(test.root, '.git', 'HEAD'), 'ref: refs/heads/changed\n')
        else throw new GitCommandError(fault, fault === 'nonzero' ? 129 : undefined)
      }
      return await original(cwd, args, ...rest)
    })
    expect(await inspectLocalProjectCommit(test.dependencies, test.binding, test.commitId, test.signal))
      .toEqual({ ok: false, reason: 'unavailable' })
  })

  it('propagates cancellation while the Commit process is being observed', async () => {
    const controller = new AbortController()
    const reason = new Error('Commit observation canceled')
    const original = test.dependencies.git.run.bind(test.dependencies.git)
    vi.spyOn(test.dependencies.git, 'run').mockImplementation(async (cwd, args, ...rest) => {
      if (args.at(-1) === `${test.commitId}^{commit}`) controller.abort(reason)
      return await original(cwd, args, ...rest)
    })
    await expect(inspectLocalProjectCommit(test.dependencies, test.binding, test.commitId, controller.signal))
      .rejects.toBe(reason)
  })

  it('rejects a Workspace that stopped owning the repository before verification', async () => {
    test.workspaces.splice(0)
    expect(await inspectLocalProjectCommit(test.dependencies, test.binding, test.commitId, test.signal))
      .toEqual({ ok: false, reason: 'binding-stale' })
  })

  it('rejects an administrative directory replaced after source-control confirmation', async () => {
    const identityReader = test.dependencies.identityReader
    let reads = 0
    vi.spyOn(test.dependencies, 'identityReader').mockImplementation(async (path, signal) => {
      reads += 1
      if (reads === 3) {
        await rename(path, join(test.root, 'retired-git'))
        await mkdir(path)
      }
      return await identityReader(path, signal)
    })
    expect(await inspectLocalProjectCommit(test.dependencies, test.binding, test.commitId, test.signal))
      .toEqual({ ok: false, reason: 'binding-stale' })
    expect(reads).toBe(4)
  })

  it.each(['absent', 'malformed', 'unavailable'] as const)('classifies an %s repository view', async (kind) => {
    const gitDirectory = join(test.root, '.git')
    if (kind === 'unavailable') await writeFile(join(gitDirectory, 'commondir'), '.\n')
    else {
      await rename(gitDirectory, join(test.root, 'retired-git'))
      if (kind === 'malformed') await writeFile(gitDirectory, 'gitdir: missing-directory\n')
    }
    expect(await inspectLocalProjectCommit(test.dependencies, test.binding, test.commitId, test.signal))
      .toEqual({ ok: false, reason: kind === 'absent' ? 'binding-stale' : 'unavailable' })
  })
})
