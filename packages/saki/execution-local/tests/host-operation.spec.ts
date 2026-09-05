import { constants as bufferConstants } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, rmdir, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  computeStartAgentRunPayloadDigest,
  hostOperationChangeSchema,
  MAX_GIT_REF_CHARS,
  MAX_HOST_OPERATION_SELECTED_CHANGES,
  MAX_PROJECT_GIT_STATUS_PATH_BYTES,
} from '@breakfastdapaidang/saki-execution'
import type {
  ActiveHostProjectBinding,
  CommitHostOperationRequest,
  HostOperationAdmissionSource,
  SakiControlIntentId,
  SakiHostId,
  SakiResourceBindingId,
  PushBranchHostOperationRequest,
  StageFilesHostOperationRequest,
  StartAgentRunHostOperationRequest,
  StartAgentRunInputMessage,
  UnstageFilesHostOperationRequest,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitCommandError, GitRunner } from '../src/git-runner.ts'
import { installLocalGitMutationInternals } from '../src/git-mutation-internals.ts'
import { installLocalGitPushInternals } from '../src/git-push-internals.ts'
import { gitHubPushArguments, type LocalGitPushTransport } from '../src/git-push.ts'
import type { OwnedPrivateGitDirectory } from '../src/owned-private-git-directory.ts'
import {
  localGitMutationNodeAdapter,
  type LocalGitMutationNodeAdapter,
} from '../src/git-mutation.ts'
import LocalSakiHostExecution, {
  MIN_OPERATION_MAX_INDEX_BYTES,
  sakiHostExecutionDomainMigrations,
  sakiHostExecutionDomainSpec,
  sakiHostExecutionV1DomainSpec,
  sakiHostExecutionV2DomainSpec,
  sakiHostExecutionV3DomainSpec,
  type Config,
} from '../src/index.ts'
import {
  hostOperationSnapshotCore,
  localHostAgentRunResultFor,
  localHostOperationRequestFingerprint,
  type LocalHostOperationRecord,
  type LocalHostPushBranchOperationRecord,
  type LocalHostStructuredGitOperationRecord,
} from '../src/operation-state.ts'
import { provideInertLocalAgentRunDependencies } from './storage.ts'

const run = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
const BINDING_ID = 'binding-11111111-1111-4111-8111-111111111111' as SakiResourceBindingId
const INTENT_ID = 'intent-11111111-1111-4111-8111-111111111111' as SakiControlIntentId
const WORKSPACE_ID = WorkspaceId('workspace-host-operation')
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

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface DetachedProcessGroupOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly cleanupTimeoutMs: number
  readonly maxOutputBytes: number
}

interface BoundedProcessOutput {
  readonly append: (chunk: Buffer) => void
  readonly text: () => string
}

function boundedProcessOutput(maxBytes: number): BoundedProcessOutput {
  const bytes = Buffer.alloc(maxBytes)
  let byteLength = 0
  let truncated = false
  return {
    append(chunk) {
      const accepted = Math.min(chunk.byteLength, maxBytes - byteLength)
      chunk.copy(bytes, byteLength, 0, accepted)
      byteLength += accepted
      if (accepted < chunk.byteLength) truncated = true
    },
    text() {
      return `${bytes.subarray(0, byteLength).toString('utf8')}${truncated ? '…[truncated]' : ''}`
    },
  }
}

async function runDetachedPosixProcessGroup(
  command: string,
  args: readonly string[],
  options: DetachedProcessGroupOptions,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  if (process.platform === 'win32') throw new Error('detached POSIX process groups are unavailable on Windows')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0
    || !Number.isSafeInteger(options.cleanupTimeoutMs) || options.cleanupTimeoutMs <= 0
    || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    throw new Error('detached process bounds must be positive safe integers')
  }
  const stdout = boundedProcessOutput(options.maxOutputBytes)
  const stderr = boundedProcessOutput(options.maxOutputBytes)
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk: Buffer) => { stdout.append(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr.append(chunk) })
  let spawnError: Error | undefined
  child.once('error', (error) => { spawnError = error })
  const closed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
    resolve => child.once('close', (code, signal) => { resolve({ code, signal }) }),
  )
  const pid = child.pid
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    child.kill('SIGKILL')
    let invalidPidTimer: NodeJS.Timeout | undefined
    const settled = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        invalidPidTimer = setTimeout(() => { resolve(false) }, options.cleanupTimeoutMs)
      }),
    ])
    if (invalidPidTimer !== undefined) clearTimeout(invalidPidTimer)
    const evidence = `stdout=${JSON.stringify(stdout.text())}; stderr=${JSON.stringify(stderr.text())}`
    if (!settled) throw new Error(`unsafe detached child did not close within ${options.cleanupTimeoutMs}ms; ${evidence}`)
    throw new Error(`detached child returned no safe independent process-group id; ${evidence}`)
  }
  let closedOutcome: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined
  void closed.then((outcome) => { closedOutcome = outcome })
  let killError: Error | undefined
  const killGroup = (): void => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      // ESRCH means every member exited before detached-group cleanup reached it.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      killError ??= error instanceof Error ? error : new Error(String(error))
      child.kill('SIGKILL')
    }
  }
  let executionTimer: NodeJS.Timeout | undefined
  const executionDeadline = new Promise<'timeout'>((resolve) => {
    executionTimer = setTimeout(() => { resolve('timeout') }, options.timeoutMs)
  })
  const execution = await Promise.race([closed.then(() => 'closed' as const), executionDeadline])
  if (executionTimer !== undefined) clearTimeout(executionTimer)
  killGroup()

  const cleanupDeadline = Date.now() + options.cleanupTimeoutMs
  let groupDrained = false
  while (Date.now() < cleanupDeadline) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        groupDrained = true
        break
      }
      killError ??= error instanceof Error ? error : new Error(String(error))
      child.kill('SIGKILL')
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const remaining = Math.max(0, cleanupDeadline - Date.now())
  let closeTimer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, remaining)
      }),
    ])
  } finally {
    if (closeTimer !== undefined) clearTimeout(closeTimer)
  }
  const cleanupFailure = killError === undefined ? '' : `; cleanup=${JSON.stringify(killError.message)}`
  const evidence = `stdout=${JSON.stringify(stdout.text())}; stderr=${JSON.stringify(stderr.text())}${cleanupFailure}`
  if (!groupDrained || closedOutcome === undefined) {
    throw new Error(`detached process-group cleanup timed out after ${options.cleanupTimeoutMs}ms; ${evidence}`)
  }
  if (killError !== undefined) throw new Error(`detached process-group cleanup failed: ${killError.message}; ${evidence}`)
  if (execution === 'timeout') throw new Error(`detached process timed out after ${options.timeoutMs}ms; ${evidence}`)
  if (spawnError !== undefined) throw new Error(`detached process failed to spawn: ${spawnError.message}; ${evidence}`)
  if (closedOutcome.code !== 0) {
    throw new Error(`detached process exited with exit code ${String(closedOutcome.code)} signal ${String(closedOutcome.signal)}; ${evidence}`)
  }
  return { stdout: stdout.text(), stderr: stderr.text() }
}

describe.skipIf(process.platform === 'win32')('POSIX detached process-group test helper', () => {
  it('returns bounded output after a normal zero exit', async () => {
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
    try {
      await expect(runDetachedPosixProcessGroup(
        process.execPath,
        ['-e', "process.stdout.write('normal stdout'); process.stderr.write('normal stderr')"],
        {
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: 5_000,
          cleanupTimeoutMs: 5_000,
          maxOutputBytes: 128,
        },
      )).resolves.toEqual({ stdout: 'normal stdout', stderr: 'normal stderr' })
      expect(clearTimer).toHaveBeenCalled()
      expect(() => process.kill(process.pid, 0)).not.toThrow()
    } finally {
      clearTimer.mockRestore()
    }
  })

  it('reports bounded stdout and stderr after a nonzero exit', async () => {
    const run = runDetachedPosixProcessGroup(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(4096)); process.stderr.write('bounded failure'); process.exit(7)"],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
        cleanupTimeoutMs: 5_000,
        maxOutputBytes: 32,
      },
    )

    await expect(run).rejects.toThrow(/exit code 7.*x{32}.*truncated.*bounded failure/su)
    expect(() => process.kill(process.pid, 0)).not.toThrow()
  })

  it('kills a timed-out detached process group and waits for its grandchild to exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-process-group-test-'))
    roots.push(root)
    const leaderPidPath = join(root, 'leader.pid')
    const grandchildPidPath = join(root, 'grandchild.pid')
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(leaderPidPath)}, String(process.pid))`,
      `const worker = spawn(${JSON.stringify(process.execPath)}, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })`,
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(worker.pid))`,
      "process.stdout.write('timeout stdout')",
      "process.stderr.write('timeout stderr')",
      'setInterval(() => {}, 1000)',
    ].join('; ')

    await expect(runDetachedPosixProcessGroup(
      process.execPath,
      ['-e', script],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 500,
        cleanupTimeoutMs: 5_000,
        maxOutputBytes: 128,
      },
    )).rejects.toThrow(/timed out.*timeout stdout.*timeout stderr/su)

    const leaderPid = Number(await readFile(leaderPidPath, 'utf8'))
    const grandchildPid = Number(await readFile(grandchildPidPath, 'utf8'))
    expect(Number.isSafeInteger(leaderPid) && leaderPid > 0).toBe(true)
    expect(Number.isSafeInteger(grandchildPid) && grandchildPid > 0).toBe(true)
    expect(() => process.kill(-leaderPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    expect(() => process.kill(grandchildPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    expect(() => process.kill(process.pid, 0)).not.toThrow()
  }, 15_000)
})

describe('LocalSakiHostExecution Host Operation lifecycle', () => {
  it('builds exact absent and existing branch leases for the fixed GitHub HTTPS target', () => {
    const common = {
      repository: { nameWithOwner: 'BreakfastDaPaiDang/saki' },
      targetRef: 'refs/heads/main',
      commitId: 'a'.repeat(40),
    }
    expect(gitHubPushArguments({ ...common, previous: { kind: 'absent' } })).toEqual([
      'push', '--porcelain', '--no-progress', '--no-verify', '--recurse-submodules=no',
      '--force-with-lease=refs/heads/main:',
      'https://github.com/BreakfastDaPaiDang/saki.git',
      `${'a'.repeat(40)}^{commit}:refs/heads/main`,
    ])
    expect(gitHubPushArguments({
      ...common,
      previous: { kind: 'commit', objectId: 'b'.repeat(40) },
    })[5]).toBe(`--force-with-lease=refs/heads/main:${'b'.repeat(40)}`)
  })

  it('publishes one exact Commit to an absent remote branch and replays without a second Push', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote)
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const commitId = await gitText(root, 'rev-parse', 'HEAD')
    const request: PushBranchHostOperationRequest = {
      type: 'push-branch',
      source: { kind: 'control-intent', intentId: INTENT_ID, intentRevision: 2, payloadDigest: '1'.repeat(64) },
      expected: { binding, commitId, repository: { nameWithOwner: 'BreakfastDaPaiDang/saki' } },
      targetRef: 'refs/heads/main',
    }
    const prepared = await execution.prepareOperation(request, acceptedAdmission(1), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('test Push was not prepared')

    const started = await execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal)
    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'push-branch',
          commitId,
          previous: { kind: 'absent' },
          credential: { helperId: 'git-credential-manager' },
        },
      },
    })
    expect(await gitText(remote, 'rev-parse', '--verify', 'refs/heads/main')).toBe(commitId)
    expect(transport.pushCount).toBe(1)
    await expect(execution.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toEqual(started.snapshot)
    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toEqual(started)
    expect(transport.pushCount).toBe(1)
  }, 30_000)

  it('uses the default fixed GitHub Push transport when no test transport is installed', async () => {
    const root = await repository()
    const commitId = await gitText(root, 'rev-parse', 'HEAD')
    let pushed = false
    const remote = vi.spyOn(GitRunner.prototype, 'runGitHubTransport').mockImplementation(async (_path, args) => {
      if (args[0] === 'push') pushed = true
      return {
        stdout: pushed && args[0] === 'ls-remote' ? Buffer.from(`${commitId}\trefs/heads/main\n`) : Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }
    })
    const execution = await provider(root, { config: { pushCredentialHelper: 'git-credential-manager' } })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(pushRequest(binding, commitId, '1'), acceptedAdmission(1), signal)
    if (!prepared.ok) throw new Error('test Push was not prepared')
    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded', result: { commitId } } })
    expect(remote.mock.calls.map(call => call[1][0])).toEqual(['ls-remote', 'ls-remote', 'push', 'ls-remote'])
  }, 30_000)

  it('publishes only a proven fast-forward over the exact remote Commit', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    await git(root, 'push', remote, 'HEAD:refs/heads/main')
    const previous = await gitText(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, 'next.txt'), 'next\n')
    await git(root, 'add', 'next.txt')
    await git(root, 'commit', '-m', 'next')
    const commitId = await gitText(root, 'rev-parse', 'HEAD')
    const transport = localPushTransport(remote, {
      async beforeRead(count, request) {
        if (count !== 1) return
        const refs = join(request.privateGitDirectory.path, 'refs', 'heads')
        await mkdir(refs, { recursive: true })
        await writeFile(join(refs, previous), `${commitId}\n`)
        await writeFile(join(refs, commitId), `${previous}\n`)
      },
    })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager-core' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, commitId, '2'), acceptedAdmission(2), signal,
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('test Push was not prepared')

    const started = await execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal)
    expect(started).toMatchObject({ ok: true, snapshot: { state: 'succeeded', result: {
      previous: { kind: 'commit', objectId: previous },
      credential: { helperId: 'git-credential-manager-core' },
    } } })
    expect(transport.pushCount).toBe(1)
    expect(await gitText(remote, 'rev-parse', '--verify', 'refs/heads/main')).toBe(commitId)
  }, 30_000)

  it('rejects a remote Commit that cannot be proven as an ancestor without attempting Push', async () => {
    const root = await repository()
    const unrelated = await repository()
    await writeFile(join(unrelated, 'unrelated.txt'), 'unrelated\n')
    await git(unrelated, 'add', 'unrelated.txt')
    await git(unrelated, 'commit', '-m', 'unrelated')
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    await git(unrelated, 'push', remote, 'HEAD:refs/heads/main')
    const transport = localPushTransport(remote)
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), '3'), acceptedAdmission(3), signal,
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('test Push was not prepared')

    const started = await execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal)
    expect(started).toMatchObject({ ok: true, snapshot: {
      state: 'failed', failure: { reason: 'unsupported-state' }, effect: 'none',
    } })
    expect(transport.pushCount).toBe(0)
  }, 30_000)

  it('propagates cancellation while proving a remote Commit ancestry', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    await git(root, 'push', remote, 'HEAD:refs/heads/main')
    await writeFile(join(root, 'next.txt'), 'next\n')
    await git(root, 'add', 'next.txt')
    await git(root, 'commit', '-m', 'next')
    const controller = new AbortController()
    const reason = new Error('stop Push ancestry proof')
    const transport = localPushTransport(remote, {
      async beforeRead(count) {
        if (count === 1) controller.abort(reason)
      },
    })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const binding = await activeBinding(execution, root, controller.signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), '9'),
      acceptedAdmission(9),
      controller.signal,
    )
    if (!prepared.ok) throw new Error('test Push was not prepared')

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      controller.signal,
    )).rejects.toBe(reason)
    expect(transport.pushCount).toBe(0)
  }, 30_000)

  it('fails without effect when the remote CAS premise moves before attempting Push', async () => {
    const root = await repository()
    const racer = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote, {
      async beforeRead(count) {
        if (count === 2) await git(racer, 'push', remote, 'HEAD:refs/heads/main')
      },
    })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), '4'), acceptedAdmission(4), signal,
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('test Push was not prepared')

    const started = await execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal)
    expect(started).toMatchObject({ ok: true, snapshot: {
      state: 'failed', failure: { reason: 'observation-stale' }, effect: 'none',
    } })
    expect(transport.pushCount).toBe(0)
  }, 30_000)

  it('classifies bound Commit failures and resumes one durable planning Push', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote, { failReads: new Set([1]) })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const commitId = await gitText(root, 'rev-parse', 'HEAD')

    const stale = pushRequest({ ...binding, workspaceId: WorkspaceId('workspace-stale') }, commitId, 'a', 'a')
    const stalePrepared = await execution.prepareOperation(stale, acceptedAdmission(8), signal)
    if (!stalePrepared.ok) throw new Error('stale-binding Push was not prepared')
    await expect(execution.startOperation(stalePrepared.preparation.operation, stalePrepared.acceptance, signal))
      .resolves.toMatchObject({ ok: true, snapshot: {
        state: 'failed', failure: { reason: 'binding-stale' }, effect: 'none',
      } })

    const missing = pushRequest(binding, 'f'.repeat(40), 'b', 'b')
    const missingPrepared = await execution.prepareOperation(missing, acceptedAdmission(9), signal)
    if (!missingPrepared.ok) throw new Error('missing-Commit Push was not prepared')
    await expect(execution.startOperation(missingPrepared.preparation.operation, missingPrepared.acceptance, signal))
      .resolves.toMatchObject({ ok: true, snapshot: {
        state: 'failed', failure: { reason: 'unsupported-state' }, effect: 'none',
      } })

    const retry = pushRequest(binding, commitId, 'c', 'c')
    const retryPrepared = await execution.prepareOperation(retry, acceptedAdmission(10), signal)
    if (!retryPrepared.ok) throw new Error('retryable Push was not prepared')
    await expect(execution.startOperation(retryPrepared.preparation.operation, retryPrepared.acceptance, signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'planning' } })
    const replayed = await execution.prepareOperation(retry, acceptedAdmission(10), signal)
    if (!replayed.ok) throw new Error('planning Push was not replayed')
    await expect(execution.startOperation(replayed.preparation.operation, replayed.acceptance, signal))
      .resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(transport.pushCount).toBe(1)

    const unavailable = pushRequest(binding, commitId, 'd', 'd')
    const unavailablePrepared = await execution.prepareOperation(unavailable, acceptedAdmission(11), signal)
    if (!unavailablePrepared.ok) throw new Error('unavailable Push was not prepared')
    await writeFile(join(root, '.git', 'config'), '[include]\n\tpath = ../outside\n')
    await expect(execution.startOperation(
      unavailablePrepared.preparation.operation,
      unavailablePrepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'planning' } })
  }, 30_000)

  it('recovers a lost Push acknowledgement by inspection without a second attempt', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote, { failReads: new Set([3]) })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const commitId = await gitText(root, 'rev-parse', 'HEAD')
    const prepared = await execution.prepareOperation(
      pushRequest(binding, commitId, '5'), acceptedAdmission(5), signal,
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('test Push was not prepared')

    const started = await execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal)
    expect(started).toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    expect(transport.pushCount).toBe(1)
    await expect(execution.cancelOperation(prepared.preparation.operation, 'source-canceled', signal))
      .resolves.toMatchObject({ state: 'publishing' })
    await rm(join(root, '.git', 'objects'), { recursive: true, force: true })
    await expect(execution.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'succeeded', result: { commitId } })
    expect(transport.pushCount).toBe(1)
  }, 30_000)

  it.each([
    { name: 'creation fails', aborts: false },
    { name: 'caller cancels creation', aborts: true },
  ])('handles attempted Push recovery when its private directory $name', async ({ aborts }) => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote)
    const controller = new AbortController()
    const cancellation = new Error('stop private recovery directory creation')
    const createTransportDirectory = vi.fn(async (): Promise<OwnedPrivateGitDirectory> => {
      if (aborts) controller.abort(cancellation)
      throw new Error('simulated private recovery directory failure')
    })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
      createTransportGitDirectory: createTransportDirectory,
    })
    const signal = controller.signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), '5', '9'),
      acceptedAdmission(25),
      signal,
    )
    if (!prepared.ok) throw new Error('test Push was not prepared')

    const started = execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal)
    if (aborts) await expect(started).rejects.toBe(cancellation)
    else {
      await expect(started)
        .resolves.toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    }
    expect(transport.pushCount).toBe(1)
    expect(createTransportDirectory).toHaveBeenCalledOnce()
  }, 30_000)

  it('unlinks a directory link from its private recovery tree without touching the target', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    const linkedTarget = await mkdtemp(join(tmpdir(), 'saki-host-operation-linked-target-'))
    roots.push(remote, linkedTarget)
    await git(remote, 'init', '--bare')
    const sentinel = join(linkedTarget, 'sentinel.txt')
    await writeFile(sentinel, 'keep\n')
    let linked = false
    const transport = localPushTransport(remote, {
      async beforeRead(count, request) {
        if (count !== 3) return
        const linkPath = join(request.privateGitDirectory.path, 'refs', 'heads')
        await rmdir(linkPath)
        await symlink(linkedTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
        linked = true
      },
    })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), '1', '2'),
      acceptedAdmission(15),
      signal,
    )
    if (!prepared.ok) throw new Error('test Push was not prepared')

    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(linked).toBe(true)
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep\n')
  }, 30_000)

  it.each([
    { name: 'unchanged remote', outcome: 'effect-unknown' as const, replaceRemote: false },
    { name: 'different remote Commit', outcome: 'evidence-conflict' as const, replaceRemote: true },
  ])('requires reconciliation when an attempted Push leaves a $name', async ({ outcome, replaceRemote }) => {
    const root = await repository()
    const racer = replaceRemote ? await repository() : undefined
    if (racer !== undefined) {
      await writeFile(join(racer, 'racer.txt'), 'racer\n')
      await git(racer, 'add', 'racer.txt')
      await git(racer, 'commit', '-m', 'racer')
    }
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote, {
      failPush: !replaceRemote,
      async afterPush() {
        if (racer !== undefined) await git(racer, 'push', '--force', remote, 'HEAD:refs/heads/main')
      },
    })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), replaceRemote ? '8' : '7'),
      acceptedAdmission(7),
      signal,
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('test Push was not prepared')

    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toMatchObject({ ok: true, snapshot: { state: 'reconciliation-required', reason: outcome } })
    expect(transport.pushCount).toBe(1)
  }, 30_000)

  it('cancels a durable not-started Push without reopening local or remote evidence', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote, { failReads: new Set([2]) })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), '6'), acceptedAdmission(6), signal,
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('test Push was not prepared')

    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    await rename(join(root, '.git'), join(root, '.git-away'))
    await expect(execution.cancelOperation(prepared.preparation.operation, 'source-canceled', signal))
      .resolves.toMatchObject({ state: 'canceled', reason: 'source-canceled', effect: 'none' })
    expect(transport.readCount).toBe(2)
    expect(transport.pushCount).toBe(0)
  }, 30_000)

  it('fails a not-started Push when recovery observes a moved remote premise', async () => {
    const root = await repository()
    const racer = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote, { failReads: new Set([2, 3]) })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), 'f'), acceptedAdmission(13), signal,
    )
    if (!prepared.ok) throw new Error('test Push was not prepared')
    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })

    const configPath = join(root, '.git', 'config')
    const config = await readFile(configPath)
    await writeFile(configPath, '[include]\n\tpath = ../outside\n')
    await expect(execution.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'publishing' })
    expect(transport.readCount).toBe(2)
    await writeFile(configPath, config)
    await expect(execution.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'publishing' })
    await expect(execution.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'publishing' })
    expect(transport.readCount).toBe(4)
    await git(racer, 'push', remote, 'HEAD:refs/heads/main')
    await expect(execution.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'failed', failure: { reason: 'observation-stale' }, effect: 'none' })
    expect(transport.pushCount).toBe(0)
  }, 30_000)

  it('fails without effect when a durable not-started Push loses its exact local Commit', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote, { failReads: new Set([2]) })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const commitId = await gitText(root, 'rev-parse', 'HEAD')
    const prepared = await execution.prepareOperation(
      pushRequest(binding, commitId, '2', '3'), acceptedAdmission(16), signal,
    )
    if (!prepared.ok) throw new Error('test Push was not prepared')
    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    await rm(join(root, '.git', 'objects', commitId.slice(0, 2), commitId.slice(2)), { force: true })

    await expect(execution.inspectOperation(prepared.preparation.operation, signal)).resolves.toMatchObject({
      state: 'failed',
      failure: { reason: 'unsupported-state' },
      effect: 'none',
    })
    expect(transport.pushCount).toBe(0)
  }, 30_000)

  it('fails without effect when starting a durable not-started Push after its Binding becomes stale', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote, { failReads: new Set([2]) })
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), '3', '4'),
      acceptedAdmission(19),
      signal,
    )
    if (!prepared.ok) throw new Error('test Push was not prepared')
    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    await rename(join(root, '.git'), join(root, '.git-away'))

    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toMatchObject({
        ok: true,
        snapshot: { state: 'failed', failure: { reason: 'binding-stale' }, effect: 'none' },
      })
    expect(transport.readCount).toBe(2)
    expect(transport.pushCount).toBe(0)
  }, 30_000)

  it('keeps a durable Push inert when its trusted credential adapter changes across restart', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    const storageRoot = await mkdtemp(join(tmpdir(), 'saki-host-operation-storage-'))
    roots.push(remote, storageRoot)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote, { failReads: new Set([2]) })
    const execution = await provider(root, {
      storageRoot,
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const request = pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), 'e')
    const prepared = await execution.prepareOperation(request, acceptedAdmission(12), signal)
    if (!prepared.ok) throw new Error('test Push was not prepared')
    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    const firstContext = contexts.pop()
    if (firstContext === undefined) throw new Error('test provider context was not retained')
    await firstContext.fiber.dispose()

    const restarted = await provider(root, {
      storageRoot,
      config: { pushCredentialHelper: 'git-credential-manager-core' },
      pushTransport: transport,
    })
    await expect(restarted.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'publishing' })
    expect(transport.readCount).toBe(2)
    expect(transport.pushCount).toBe(0)

    const changedContext = contexts.pop()
    if (changedContext === undefined) throw new Error('restarted test provider context was not retained')
    await changedContext.fiber.dispose()
    const restored = await provider(root, {
      storageRoot,
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const replayed = await restored.prepareOperation(request, acceptedAdmission(12), signal)
    if (!replayed.ok) throw new Error('durable Push was not replayed after restoring its credential adapter')
    await expect(restored.startOperation(replayed.preparation.operation, replayed.acceptance, signal))
      .resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(transport.pushCount).toBe(1)
  }, 30_000)

  it('replays a terminal Push after its credential helper is unconfigured', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    const storageRoot = await mkdtemp(join(tmpdir(), 'saki-host-operation-storage-'))
    roots.push(remote, storageRoot)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote)
    const execution = await provider(root, {
      storageRoot,
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const request = pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), '4')
    const prepared = await execution.prepareOperation(request, acceptedAdmission(17), signal)
    if (!prepared.ok) throw new Error('test Push was not prepared')
    const started = await execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal)
    if (!started.ok) throw new Error('test Push did not succeed')
    const readCount = transport.readCount
    const firstContext = contexts.pop()
    if (firstContext === undefined) throw new Error('test provider context was not retained')
    await firstContext.fiber.dispose()

    const restarted = await provider(root, { storageRoot, pushTransport: transport })
    await expect(restarted.prepareOperation(request, acceptedAdmission(17), signal)).resolves.toMatchObject({
      ok: true,
      snapshot: started.snapshot,
    })
    await expect(restarted.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toEqual(started.snapshot)
    await expect(restarted.cancelOperation(prepared.preparation.operation, 'source-canceled', signal))
      .resolves.toEqual(started.snapshot)
    expect(transport.readCount).toBe(readCount)
    expect(transport.pushCount).toBe(1)
  }, 30_000)

  it('inspects and cancels a durable not-started Push after its helper is unconfigured', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    const storageRoot = await mkdtemp(join(tmpdir(), 'saki-host-operation-storage-'))
    roots.push(remote, storageRoot)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote, { failReads: new Set([2]) })
    const execution = await provider(root, {
      storageRoot,
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const request = pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), '5')
    const prepared = await execution.prepareOperation(request, acceptedAdmission(18), signal)
    if (!prepared.ok) throw new Error('test Push was not prepared')
    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    const firstContext = contexts.pop()
    if (firstContext === undefined) throw new Error('test provider context was not retained')
    await firstContext.fiber.dispose()

    const restarted = await provider(root, { storageRoot, pushTransport: transport })
    const replayed = await restarted.prepareOperation(request, acceptedAdmission(18), signal)
    if (!replayed.ok) throw new Error('durable Push was not replayed without its credential helper')
    await expect(restarted.startOperation(replayed.preparation.operation, replayed.acceptance, signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    await expect(restarted.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'publishing' })
    await expect(restarted.cancelOperation(prepared.preparation.operation, 'source-canceled', signal))
      .resolves.toMatchObject({ state: 'canceled', reason: 'source-canceled', effect: 'none' })
    expect(transport.readCount).toBe(2)
    expect(transport.pushCount).toBe(0)
  }, 30_000)

  it('keeps an attempted Push inert when its helper is unconfigured', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    const storageRoot = await mkdtemp(join(tmpdir(), 'saki-host-operation-storage-'))
    roots.push(remote, storageRoot)
    await git(remote, 'init', '--bare')
    const transport = localPushTransport(remote, { failReads: new Set([3]) })
    const execution = await provider(root, {
      storageRoot,
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: transport,
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), '6', '5'),
      acceptedAdmission(20),
      signal,
    )
    if (!prepared.ok) throw new Error('test Push was not prepared')
    const started = await execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal)
    expect(started).toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    const firstContext = contexts.pop()
    if (firstContext === undefined) throw new Error('test provider context was not retained')
    await firstContext.fiber.dispose()

    const restarted = await provider(root, { storageRoot, pushTransport: transport })
    await expect(restarted.inspectOperation(prepared.preparation.operation, signal))
      .resolves.toEqual(started.snapshot)
    await expect(restarted.cancelOperation(prepared.preparation.operation, 'source-canceled', signal))
      .resolves.toEqual(started.snapshot)
    expect(transport.readCount).toBe(3)
    expect(transport.pushCount).toBe(1)
  }, 30_000)

  it('rejects corrupted durable Push result evidence', async () => {
    const root = await repository()
    const remote = await mkdtemp(join(tmpdir(), 'saki-host-operation-remote-'))
    roots.push(remote)
    await git(remote, 'init', '--bare')
    const execution = await provider(root, {
      config: { pushCredentialHelper: 'git-credential-manager' },
      pushTransport: localPushTransport(remote, { failReads: new Set([2]) }),
    })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const prepared = await execution.prepareOperation(
      pushRequest(binding, await gitText(root, 'rev-parse', 'HEAD'), '0'), acceptedAdmission(14), signal,
    )
    if (!prepared.ok) throw new Error('test Push was not prepared')
    const persistence = operationPersistence(execution)
    let durable: LocalHostPushBranchOperationRecord | undefined
    persistence.replace(async (record) => {
      if (isPushOperationRecord(record) && record.effectPlan?.kind === 'push-branch') durable = record
      await persistence.original(record)
    })
    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .resolves.toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'push-branch') throw new Error('test did not retain a Push plan')

    expect(sakiHostExecutionDomainSpec.tables.operations.valueSchema.safeParse(durable).success).toBe(true)
    expectOperationRecordIssue({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        result: {
          ...durable.effectPlan.result,
          repository: { nameWithOwner: 'BreakfastDaPaiDang/other' },
        },
      },
    }, 'Push effect plan result disagrees with request')
  }, 30_000)

  it('rereads only one exact local Commit through the active Binding', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const commitId = await gitText(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, 'later.txt'), 'later\n')
    await git(root, 'add', 'later.txt')
    await git(root, 'commit', '-m', 'later')

    await expect(execution.inspectProjectCommit({ binding, commitId }, signal))
      .resolves.toEqual({ ok: true, commitId })
    await expect(execution.inspectProjectCommit({
      binding: { ...binding, workspaceId: WorkspaceId('workspace-other') },
      commitId,
    }, signal)).resolves.toEqual({ ok: false, reason: 'binding-stale' })
    await expect(execution.inspectProjectCommit({ binding, commitId: 'f'.repeat(40) }, signal))
      .resolves.toEqual({ ok: false, reason: 'commit-missing' })
    const blobId = await gitText(root, 'hash-object', 'tracked.txt')
    await expect(execution.inspectProjectCommit({ binding, commitId: blobId }, signal))
      .resolves.toEqual({ ok: false, reason: 'commit-missing' })

    await rename(join(root, '.git'), join(root, '.git-away'))
    await expect(execution.inspectProjectCommit({ binding, commitId }, signal))
      .resolves.toEqual({ ok: false, reason: 'binding-stale' })
    await rename(join(root, '.git-away'), join(root, '.git'))

    await writeFile(join(root, '.git', 'config'), '[include]\n\tpath = ../outside\n')
    await expect(execution.inspectProjectCommit({ binding, commitId }, signal))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  }, 30_000)

  it('keeps Push unavailable when no trusted credential adapter is configured', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const request: PushBranchHostOperationRequest = {
      type: 'push-branch',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '0'.repeat(64),
      },
      expected: {
        binding,
        commitId: await gitText(root, 'rev-parse', 'HEAD'),
        repository: { nameWithOwner: 'BreakfastDaPaiDang/saki' },
      },
      targetRef: 'refs/heads/main',
    }

    await expect(execution.prepareOperation(request, acceptedAdmission(1), signal))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  }, 30_000)

  it('prepares one inert durable operation, replays it exactly, and cancels before effect', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete') return
    const change = inspected.observation.changes[0]
    expect(change).toBeDefined()
    if (change === undefined || inspected.observation.index.kind !== 'tree') return
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '1'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const admit = vi.fn<HostOperationAdmissionSource>()
    const changes: unknown[] = []
    const dispose = execution.onChanged(change => changes.push(change))

    const first = await execution.prepareOperation(request, admit, signal)
    expect(first).toMatchObject({
      ok: true,
      preparation: {
        operation: {
          id: 'host-operation-11111111-1111-4111-8111-111111111111',
          hostId: HOST_ID,
          type: 'stage-files',
        },
        preparationRevision: 0,
        requestFingerprint: { version: 1 },
      },
      snapshot: { state: 'prepared', revision: 0, admission: { kind: 'not-accepted' } },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(admit).not.toHaveBeenCalled()
    expect(changes).toHaveLength(1)
    expect(() => hostOperationChangeSchema.parse(changes[0])).not.toThrow()
    if (!first.ok) return

    const replay = await execution.prepareOperation(request, admit, signal)
    expect(replay).toMatchObject({
      ok: true,
      preparation: first.preparation,
      snapshot: first.snapshot,
    })
    expect(changes).toHaveLength(1)

    const changedReplay = await execution.prepareOperation({
      ...request,
      expected: { ...request.expected, binding: { ...binding, revision: 1 } },
    }, admit, signal)
    expect(changedReplay).toEqual({ ok: false, reason: 'source-conflict' })

    const canceled = await execution.cancelOperation(
      first.preparation.operation,
      'source-canceled',
      signal,
    )
    expect(canceled).toMatchObject({
      state: 'canceled',
      revision: 1,
      admission: { kind: 'not-accepted' },
      reason: 'source-canceled',
      effect: 'none',
    })
    expect(changes).toHaveLength(2)
    dispose()
  }, 30_000)

  it('publishes one selected worktree change through an alternate index', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete') return
    const change = inspected.observation.changes[0]
    if (change === undefined || inspected.observation.index.kind !== 'tree') return
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '2'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const admission: HostOperationAdmissionSource = () => Promise.resolve({
      kind: 'accepted',
      admissionRevision: 7,
    })
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        admission: { kind: 'accepted', revision: 7 },
        result: {
          type: 'stage-files',
          changes: [{ id: change.id, path: 'tracked.txt' }],
          resultingIndex: { kind: 'tree' },
        },
      },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    expect(liveOperationCount(execution)).toBe(0)
    const terminalReplay = await execution.prepareOperation(request, admission, signal)
    expect(terminalReplay.ok).toBe(true)
    expect(liveOperationCount(execution)).toBe(0)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toEqual(started.snapshot)
    expect(liveOperationCount(execution)).toBe(0)
    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toEqual(started)
  }, 30_000)

  it('stages a real tracked deletion without recreating the worktree path', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await unlink(join(root, 'tracked.txt'))
    const inspected = await execution.inspectProject({ binding }, signal)
    if (!inspected.ok) throw new Error(`test deletion was not inspectable: ${inspected.reason}`)
    const change = inspected.observation.changes.find(candidate => candidate.path === 'tracked.txt')
    if (change === undefined) throw new Error('test inspection exposed no tracked deletion')
    const prepared = await prepareStageSelection(
      execution, binding, inspected, [{ id: change.id, fingerprint: change.fingerprint }], signal, '2',
    )

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'stage-files',
          changes: [{ id: change.id, path: 'tracked.txt' }],
        },
      },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-status')).toBe('D\ttracked.txt')
    expect(await gitText(root, 'ls-files', '--', 'tracked.txt')).toBe('')
    await expect(stat(join(root, 'tracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  }, 45_000)

  it('rejects a staged-only ordinary change selected for Stage without changing its index', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'staged-only change\n')
    await git(root, 'add', '--', 'tracked.txt')
    const inspected = await execution.inspectProject({ binding }, signal)
    if (!inspected.ok) throw new Error(`test staged change was not inspectable: ${inspected.reason}`)
    const change = inspected.observation.changes.find(candidate => candidate.path === 'tracked.txt')
    if (change === undefined || change.kind !== 'ordinary') throw new Error('test exposed no ordinary staged change')
    expect(change.worktreeStatus).toBe('unchanged')
    expect(change.indexStatus).not.toBe('unchanged')
    const indexPath = join(root, '.git', 'index')
    const stagedIndex = await readFile(indexPath)
    const prepared = await prepareStageSelection(
      execution, binding, inspected, [{ id: change.id, fingerprint: change.fingerprint }], signal, '3',
    )

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'invalid-selection' },
        effect: 'none',
      },
    })
    await expect(readFile(indexPath)).resolves.toEqual(stagedIndex)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  }, 45_000)

  it.each(['unknown id', 'wrong fingerprint'] as const)(
    'rejects a valid-shaped selected change with an %s',
    async (kind) => {
      const root = await repository()
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const execution = await provider(root)
      const signal = new AbortController().signal
      const binding = await activeBinding(execution, root, signal)
      const worktreeContents = 'selected worktree change\n'
      await writeFile(join(root, 'tracked.txt'), worktreeContents)
      const inspected = await execution.inspectProject({ binding }, signal)
      if (!inspected.ok) throw new Error(`test change was not inspectable: ${inspected.reason}`)
      const change = inspected.observation.changes.find(candidate => candidate.path === 'tracked.txt')
      if (change === undefined) throw new Error('test inspection exposed no selected change')
      const selection: StageFilesHostOperationRequest['changes'] = [{
        id: kind === 'unknown id'
          ? `git-change-${'f'.repeat(64)}` as typeof change.id
          : change.id,
        fingerprint: kind === 'wrong fingerprint'
          ? { ...change.fingerprint, digest: differentHex(change.fingerprint.digest) }
          : change.fingerprint,
      }]
      const indexPath = join(root, '.git', 'index')
      const originalIndex = await readFile(indexPath)
      const prepared = await prepareStageSelection(
        execution, binding, inspected, selection, signal, kind === 'unknown id' ? '4' : '5',
      )

      const started = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )

      expect(started).toMatchObject({
        ok: true,
        snapshot: {
          state: 'failed',
          failure: { reason: 'invalid-selection' },
          effect: 'none',
        },
      })
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      await expect(readFile(join(root, 'tracked.txt'), 'utf8')).resolves.toBe(worktreeContents)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    },
    45_000,
  )

  it('publishes one selected worktree change in a SHA-256 repository', async () => {
    const root = await repository('sha256')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, change } = await preparedStage(execution, root, signal, '2', 7)

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: { type: 'stage-files', changes: [{ id: change.id, path: 'tracked.txt' }] },
      },
    })
    if (!started.ok || started.snapshot.state !== 'succeeded'
      || started.snapshot.result.type !== 'stage-files') return
    expect(started.snapshot.result.resultingIndex.treeId).toHaveLength(64)
  }, 30_000)

  it('restores one selected index change from HEAD without changing the worktree', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    await git(root, 'add', '--', 'tracked.txt')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete') return
    const change = inspected.observation.changes[0]
    if (change === undefined || inspected.observation.index.kind !== 'tree') return
    const request: UnstageFilesHostOperationRequest = {
      type: 'unstage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '3'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const admission: HostOperationAdmissionSource = () => Promise.resolve({
      kind: 'accepted',
      admissionRevision: 8,
    })
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started'
        && (record.effectPlan.kind === 'index' || record.effectPlan.kind === 'commit')) {
        durable = record
        throw new Error('simulated Unstage plan acknowledgement loss')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated Unstage plan acknowledgement loss')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Unstage plan')
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).resolves.toBeDefined()

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'unstage-files',
          changes: [{ id: change.id, path: 'tracked.txt' }],
          resultingIndex: { kind: 'tree' },
        },
      },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(await gitText(root, 'diff', '--name-only')).toBe('tracked.txt')
  }, 30_000)

  it('does not publish an Unstage when the caller aborts during write admission', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'caller-abort\n')
    await git(root, 'add', '--', 'tracked.txt')
    const execution = await provider(root)
    const setupSignal = new AbortController().signal
    const binding = await activeBinding(execution, root, setupSignal)
    const inspected = await execution.inspectProject({ binding }, setupSignal)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') {
      throw new Error(`test repository was not mutable: ${JSON.stringify(inspected)}`)
    }
    const change = inspected.observation.changes[0]
    if (change === undefined) throw new Error('test repository had no staged path')
    const request: UnstageFilesHostOperationRequest = {
      type: 'unstage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: 'd'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const caller = new AbortController()
    const callerReason = new Error('caller stopped the Unstage start')
    const admission: HostOperationAdmissionSource = () => {
      caller.abort(callerReason)
      return Promise.resolve({ kind: 'accepted', admissionRevision: 24 })
    }
    const prepared = await execution.prepareOperation(request, admission, setupSignal)
    if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const stagedTree = await gitText(root, 'write-tree')

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      caller.signal,
    )).rejects.toBe(callerReason)

    expect(await execution.inspectOperation(prepared.preparation.operation, setupSignal)).toMatchObject({
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'write-tree')).toBe(stagedTree)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 45_000)

  it('does not create the blocking index lock after caller abort follows final pin evidence', async () => {
    const root = await repository()
    const controller = new AbortController()
    const reason = new Error('caller stopped before index lock acquisition')
    const { node, state } = abortAfterOwnedIndexRead(root, controller, reason, 'pin', 2)
    const execution = await provider(root, { node })
    const { prepared } = await preparedStage(execution, root, controller.signal, '4', 25)
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      controller.signal,
    )).rejects.toBe(reason)

    expect(state.abortedAt).toEqual({ kind: 'pin', count: 2 })
    expect(state.linkCalls).toBe(0)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })

    const freshSignal = new AbortController().signal
    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      freshSignal,
    )).toMatchObject({ state: 'canceled', effect: 'none' })
  }, 60_000)

  it('does not publish the index after caller abort follows final lock evidence', async () => {
    const root = await repository()
    const controller = new AbortController()
    const reason = new Error('caller stopped before index publication')
    const { node, state } = abortAfterOwnedIndexRead(root, controller, reason, 'lock', 2)
    const execution = await provider(root, { node })
    const { prepared } = await preparedStage(execution, root, controller.signal, '5', 26)
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      controller.signal,
    )).rejects.toBe(reason)

    expect(state.abortedAt).toEqual({ kind: 'lock', count: 2 })
    expect(state.linkCalls).toBe(1)
    expect(state.renameCalls).toBe(0)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })

    const freshSignal = new AbortController().signal
    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      freshSignal,
    )).toMatchObject({
      state: 'reconciliation-required',
      reason: 'evidence-conflict',
    })
  }, 60_000)

  it.each([
    ['Stage', 'stage-files'],
    ['Unstage', 'unstage-files'],
  ] as const)('fails %s before effect when accepted index evidence drifts', async (_label, operationType) => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    if (operationType === 'unstage-files') await git(root, 'add', '--', 'tracked.txt')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') return
    const change = inspected.observation.changes[0]
    if (change === undefined) throw new Error('test repository had no changed path')
    const common = {
      source: {
        kind: 'control-intent' as const,
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '4'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const request: StageFilesHostOperationRequest | UnstageFilesHostOperationRequest
      = operationType === 'stage-files'
        ? { type: 'stage-files', ...common }
        : { type: 'unstage-files', ...common }
    const prepared = await execution.prepareOperation(
      request,
      () => Promise.resolve({ kind: 'accepted', admissionRevision: 9 }),
      signal,
    )
    if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)
    await writeFile(join(root, 'index-drift.txt'), 'external index change\n')
    await git(root, 'add', '--', 'index-drift.txt')
    const externallyChangedTree = await gitText(root, 'write-tree')

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'observation-stale' },
        effect: 'none',
      },
    })
    expect(liveOperationCount(execution)).toBe(0)
    expect(await gitText(root, 'write-tree')).toBe(externallyChangedTree)
    expect(await gitText(root, 'diff', '--cached', '--name-only', '--', 'tracked.txt')).toBe(
      operationType === 'stage-files' ? '' : 'tracked.txt',
    )
  }, 45_000)

  it('bounds a shared-index read that grows after its opened metadata is captured', async () => {
    const root = await repository()
    await writeFile(join(root, 'second.txt'), 'expand the shared index\n')
    await git(root, 'add', '--', 'second.txt')
    await git(root, 'commit', '-m', 'expand index for exact bound')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const state = {
      grew: false,
      publishCalls: 0,
      reads: [] as Array<{ readonly bufferLength: number; readonly length: number; readonly position: number }>,
    }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (path !== indexPath || flags !== 'r') return handle
        return {
          ...handle,
          async stat() {
            const observed = await handle.stat()
            if (!state.grew) {
              state.grew = true
              await writeFile(path, Buffer.from([0x78]), { flag: 'a' })
            }
            return observed
          },
          async read(buffer, offset, length, position) {
            state.reads.push({ bufferLength: buffer.byteLength, length, position })
            return await handle.read(buffer, offset, length, position)
          },
        }
      },
      async rename(from, to) {
        if (from === `${indexPath}.lock` && to === indexPath) state.publishCalls += 1
        await localGitMutationNodeAdapter.rename(from, to)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '4', 25)
    const bound = originalIndex.byteLength
    expect(bound).toBeGreaterThanOrEqual(MIN_OPERATION_MAX_INDEX_BYTES)
    const runtime = execution as unknown as { config: { operationMaxIndexBytes: number } }
    const originalBound = runtime.config.operationMaxIndexBytes
    runtime.config.operationMaxIndexBytes = bound

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    ).finally(() => { runtime.config.operationMaxIndexBytes = originalBound })
    expect(started).toMatchObject({
      ok: false,
      reason: 'unavailable',
      snapshot: { state: 'planning', revision: 2 },
    })

    expect(state.grew).toBe(true)
    expect(state.publishCalls).toBe(0)
    expect(state.reads.length).toBeGreaterThan(0)
    expect(Math.max(...state.reads.map(read => read.bufferLength))).toBe(bound)
    expect(state.reads.every(read => read.bufferLength <= bound && read.length <= bound)).toBe(true)
    expect(state.reads.at(-1)).toMatchObject({ bufferLength: 1, length: 1, position: bound })
    await expect(readFile(indexPath)).resolves.toEqual(Buffer.concat([originalIndex, Buffer.from([0x78])]))
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it.each([
    { name: 'keeps the bounded index result', abortOnClose: false },
    { name: 'preserves abort priority', abortOnClose: true },
  ] as const)('ignores a bounded-file handle close rejection and $name', async ({ abortOnClose }) => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const controller = new AbortController()
    const abortReason = new Error('bounded-file close abort wins')
    const closeFailure = new Error('injected bounded-file close rejection')
    const state = { armed: false, closeCalls: 0, scratchPath: undefined as string | undefined }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (state.armed && flags === 'wx' && basename(path) === 'owner'
          && basename(dirname(path)).startsWith('saki-host-operation-')) {
          const scratchPath = dirname(path)
          state.scratchPath = scratchPath
          roots.push(scratchPath)
        }
        if (!state.armed || path !== indexPath || flags !== 'r') return handle
        return {
          ...handle,
          async close() {
            state.closeCalls += 1
            await handle.close()
            if (abortOnClose) controller.abort(abortReason)
            throw closeFailure
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const { prepared } = await preparedStage(
      execution,
      root,
      controller.signal,
      abortOnClose ? '6' : '5',
      abortOnClose ? 27 : 26,
    )
    state.armed = true

    if (abortOnClose) {
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        controller.signal,
      )).rejects.toBe(abortReason)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    } else {
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        controller.signal,
      )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    }
    expect(state.closeCalls).toBeGreaterThan(0)
    expect(state.scratchPath).toBeDefined()
    await expect(stat(state.scratchPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it('honors an abort raised while closing final bounded index evidence', async () => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const controller = new AbortController()
    const abortReason = new Error('final bounded-file close abort wins')
    const closeFailure = new Error('injected final bounded-file close rejection')
    const state = { armed: false, closed: false }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (!state.armed || path !== indexPath || flags !== 'r') return handle
        return {
          ...handle,
          async close() {
            await handle.close()
            state.closed = true
            controller.abort(abortReason)
            throw closeFailure
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const { prepared } = await preparedStage(execution, root, controller.signal, '6', 27)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
        && record.effectPlan.publication === 'attempting') {
        durable = record
        roots.push(record.effectPlan.scratch.path)
        throw new Error('captured durable attempted Stage for final bounded read')
      }
    })
    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      controller.signal,
    )).rejects.toThrow('captured durable attempted Stage for final bounded read')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no attempted Stage plan')
    state.armed = true

    await expect(execution.inspectOperation(
      prepared.preparation.operation,
      controller.signal,
    )).rejects.toBe(abortReason)

    expect(state.closed).toBe(true)
    state.armed = false
    await expect(execution.inspectOperation(
      prepared.preparation.operation,
      new AbortController().signal,
    )).resolves.toMatchObject({ state: 'reconciliation-required' })
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 90_000)

  it.skipIf(process.platform === 'win32')(
    'does not block when a bounded index pathname becomes a FIFO before open',
    async () => {
      if (process.env.SAKI_FIFO_BOUNDED_READ_CHILD !== '1') {
        const childTempRoot = await mkdtemp(join(tmpdir(), 'saki-fifo-child-'))
        roots.push(childTempRoot)
        await runDetachedPosixProcessGroup(process.execPath, [
          join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'),
          'run',
          'packages/saki/execution-local/tests/host-operation.spec.ts',
          '--pool=forks',
          '--maxWorkers=1',
          '--testNamePattern',
          'does not block when a bounded index pathname becomes a FIFO before open',
        ], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            SAKI_FIFO_BOUNDED_READ_CHILD: '1',
            TMPDIR: childTempRoot,
            TMP: childTempRoot,
            TEMP: childTempRoot,
          },
          timeoutMs: 75_000,
          cleanupTimeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        })
        return
      }
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const backupPath = `${indexPath}.retained-original`
      const fifoPath = `${indexPath}.retained-fifo`
      const originalIndex = await readFile(indexPath)
      const state = { raced: false, restored: false, publishCalls: 0 }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          const observed = await localGitMutationNodeAdapter.lstat(path)
          if (path === indexPath && !state.raced) {
            state.raced = true
            await localGitMutationNodeAdapter.rename(path, backupPath)
            await run('mkfifo', [path], { windowsHide: true })
          }
          return observed
        },
        async open(path, flags, mode) {
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (path === indexPath && flags === 'r' && state.raced && !state.restored) {
            await localGitMutationNodeAdapter.rename(path, fifoPath)
            await localGitMutationNodeAdapter.rename(backupPath, path)
            state.restored = true
          }
          return handle
        },
        async rename(from, to) {
          if (from === `${indexPath}.lock` && to === indexPath) state.publishCalls += 1
          await localGitMutationNodeAdapter.rename(from, to)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '4', 25)

      const started = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )

      expect(state).toEqual({ raced: true, restored: true, publishCalls: 0 })
      expect(started).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'planning', revision: 2 },
      })
      expect((await stat(fifoPath)).isFIFO()).toBe(true)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    },
    90_000,
  )

  it.runIf(process.platform === 'win32')(
    'reads ordinary index files through the Windows bounded-open fallback',
    async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      let boundedReads = 0
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async open(path, flags, mode) {
          if (path === indexPath && flags === 'r') boundedReads += 1
          return await localGitMutationNodeAdapter.open(path, flags, mode)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '4', 25)
      const beforeTree = await gitText(root, 'write-tree')
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

      const started = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )

      expect(boundedReads).toBeGreaterThan(0)
      expect(started).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'write-tree')).not.toBe(beforeTree)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    },
    60_000,
  )

  it('rejects a Stage when the bound Git directory identity is replaced after preparation', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, 'b', 22)
    await rename(join(root, '.git'), join(root, '.git-replaced'))
    await git(root, 'init', '--quiet', '--initial-branch=main')
    await git(root, 'config', 'user.name', 'Replacement')
    await git(root, 'config', 'user.email', 'replacement@example.invalid')
    await git(root, 'add', '--', 'tracked.txt')
    await git(root, 'commit', '--quiet', '-m', 'replacement repository')
    const replacementHead = await gitText(root, 'rev-parse', 'HEAD')
    const replacementIndex = await gitText(root, 'write-tree')

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: { state: 'failed', failure: { reason: 'binding-stale' }, effect: 'none' },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(replacementHead)
    expect(await gitText(root, 'write-tree')).toBe(replacementIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 45_000)

  it.skipIf(process.platform === 'win32')(
    'stages a filename containing newline and tab bytes through its Host-resolved selection',
    async () => {
      const root = await repository()
      const execution = await provider(root)
      const signal = new AbortController().signal
      const binding = await activeBinding(execution, root, signal)
      const path = 'line\nbreak\tname.txt'
      await writeFile(join(root, path), 'NUL-safe path\n')
      const inspected = await execution.inspectProject({ binding }, signal)
      expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
      if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
        || inspected.observation.index.kind !== 'tree') return
      const change = inspected.observation.changes.find(candidate => candidate.path === path)
      if (change === undefined) throw new Error('test status did not preserve the exact filename')
      const request: StageFilesHostOperationRequest = {
        type: 'stage-files',
        source: {
          kind: 'control-intent',
          intentId: INTENT_ID,
          intentRevision: 2,
          payloadDigest: '0'.repeat(64),
        },
        expected: {
          binding,
          status: inspected.observation.fingerprint,
          head: inspected.observation.head,
          index: inspected.observation.index,
          worktree: inspected.observation.worktree,
          preEffectBaseline: inspected.preEffectBaseline,
        },
        changes: [{ id: change.id, fingerprint: change.fingerprint }],
      }
      const prepared = await execution.prepareOperation(
        request,
        () => Promise.resolve({ kind: 'accepted', admissionRevision: 9 }),
        signal,
      )
      if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)

      const started = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )

      expect(started).toMatchObject({
        ok: true,
        snapshot: {
          state: 'succeeded',
          result: { type: 'stage-files', changes: [{ id: change.id, path }] },
        },
      })
      expect(await gitText(root, 'ls-files', '-z', '--', path)).toBe(`${path}\0`)
    },
    45_000,
  )

  it('keeps a foreign index lock retryable and publishes after the lock clears', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete') return
    const change = inspected.observation.changes[0]
    if (change === undefined || inspected.observation.index.kind !== 'tree') return
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '4'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const admission: HostOperationAdmissionSource = () => Promise.resolve({
      kind: 'accepted',
      admissionRevision: 9,
    })
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const lockPath = join(root, '.git', 'index.lock')
    await writeFile(lockPath, 'foreign lock\n', { flag: 'wx' })

    const busy = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(busy).toMatchObject({ ok: false, reason: 'busy', snapshot: { state: 'planning' } })
    expect(await readFile(lockPath, 'utf8')).toBe('foreign lock\n')
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    await unlink(lockPath)

    const retried = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    expect(retried, JSON.stringify(retried)).toMatchObject({
      ok: true,
      snapshot: { state: 'succeeded', result: { type: 'stage-files' } },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 45_000)

  it('does not reuse or delete a pre-plan pin residue from the same operation', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '4', 9)
    const residue = join(
      root,
      '.git',
      `index.saki-${prepared.preparation.operation.id}-${'a'.repeat(32)}.pin`,
    )
    await writeFile(residue, 'pre-plan residue\n', { flag: 'wx' })

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await readFile(residue, 'utf8')).toBe('pre-plan residue\n')
  }, 60_000)

  it('preserves the existing shared index permission bits during Stage publication', async () => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const requestedMode = process.platform === 'win32' ? 0o666 : 0o640
    await chmod(indexPath, requestedMode)
    const expectedMode = Number((await stat(indexPath, { bigint: true })).mode & 0o777n)
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '4', 9)

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(Number((await stat(indexPath, { bigint: true })).mode & 0o777n)).toBe(expectedMode)
  }, 60_000)

  it('creates a missing shared index with the Git-style umask mode', async () => {
    const root = await unbornRepository()
    await writeFile(join(root, 'first.txt'), 'first\n')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const inspected = await execution.inspectProject({ binding }, signal)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') {
      throw new Error(`test repository was not mutable: ${JSON.stringify(inspected)}`)
    }
    const change = inspected.observation.changes.find(candidate => candidate.path === 'first.txt')
    if (change === undefined) throw new Error('test repository exposed no untracked file')
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '4'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const prepared = await execution.prepareOperation(
      request,
      () => Promise.resolve({ kind: 'accepted', admissionRevision: 9 }),
      signal,
    )
    if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)
    await expect(stat(join(root, '.git', 'index'))).rejects.toMatchObject({ code: 'ENOENT' })
    const modeProbePath = join(root, '.git', 'mode-probe')
    await (await open(modeProbePath, 'wx', 0o666)).close()
    const expectedMode = Number((await stat(modeProbePath, { bigint: true })).mode & 0o777n)
    await unlink(modeProbePath)

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(Number((await stat(join(root, '.git', 'index'), { bigint: true })).mode & 0o777n)).toBe(expectedMode)
  }, 60_000)

  it('fails before effect when unsupported index flags appear after prepare', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete') return
    const change = inspected.observation.changes[0]
    if (change === undefined || inspected.observation.index.kind !== 'tree') return
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '5'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const admission: HostOperationAdmissionSource = () => Promise.resolve({
      kind: 'accepted',
      admissionRevision: 10,
    })
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    await git(root, 'update-index', '--assume-unchanged', '--', 'tracked.txt')

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
  }, 30_000)

  it('rejects a selected path whose directory-file conflict depends on an unselected index change', async () => {
    const root = await repository()
    await writeFile(join(root, 'slot'), 'file\n')
    await git(root, 'add', '--', 'slot')
    await git(root, 'commit', '-m', 'add file-shaped slot')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await unlink(join(root, 'slot'))
    await mkdir(join(root, 'slot'))
    await writeFile(join(root, 'slot', 'child.txt'), 'child\n')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') return
    const child = inspected.observation.changes.find(change => change.path === 'slot/child.txt')
    if (child === undefined) throw new Error('test status did not expose the child path')
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '6'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: child.id, fingerprint: child.fingerprint }],
    }
    const prepared = await execution.prepareOperation(
      request,
      () => Promise.resolve({ kind: 'accepted', admissionRevision: 11 }),
      signal,
    )
    if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
  }, 45_000)

  it('inspection never resumes a durable not-started publication and cancellation proves no effect', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
      }
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated crash before attempting evidence became durable')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable index plan')
    const lockPath = join(root, '.git', 'index.lock')
    await link(durable.effectPlan.pin.path, lockPath)

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'publishing',
    })
    await expect(stat(lockPath)).resolves.toBeDefined()
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 45_000)

  it('preserves a same-content foreign lock that replaced a durable Stage hard link', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
      }
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated crash before Stage attempt became durable')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash before Stage attempt became durable')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable index plan')
    const lockPath = join(root, '.git', 'index.lock')
    const pinBytes = await readFile(durable.effectPlan.pin.path)
    await writeFile(lockPath, pinBytes, { flag: 'wx', mode: durable.effectPlan.pin.mode })
    const foreign = await stat(lockPath, { bigint: true })
    expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).not.toEqual(
      durable.effectPlan.pin.identity,
    )

    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none' })
    await expect(readFile(lockPath)).resolves.toEqual(pinBytes)
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await unlink(lockPath)
  }, 60_000)

  it('keeps a grown owned index hard link non-terminal until exact evidence is restored', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
        && record.effectPlan.publication === 'not-started') {
        durable = record
        throw new Error('captured durable Stage pin before attempt')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('captured durable Stage pin before attempt')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    const pin = durable.effectPlan.pin
    const pinBytes = await readFile(pin.path)
    const lockPath = join(root, '.git', 'index.lock')
    await link(pin.path, lockPath)
    await writeFile(lockPath, Buffer.from([0]), { flag: 'a' })
    expect((await stat(lockPath)).size).toBe(pin.byteLength + 1)

    await expect(execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).rejects.toThrow('temporarily unavailable')
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'publishing',
    })
    expect((await stat(lockPath)).size).toBe(pin.byteLength + 1)
    expect((await stat(pin.path)).size).toBe(pin.byteLength + 1)

    await writeFile(lockPath, pinBytes)
    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none' })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it.each(['absent', 'foreign'] as const)(
    'cancels with a lowered index bound when the blocking lock is %s',
    async (lockState) => {
      const root = await repository()
      await writeFile(join(root, 'second.txt'), 'second tracked file\n')
      await git(root, 'add', '--', 'second.txt')
      await git(root, 'commit', '-m', 'expand index')
      const execution = await provider(root)
      const signal = new AbortController().signal
      const selectedPath = `untracked-${'x'.repeat(180)}.txt`
      const { prepared } = await preparedStage(execution, root, signal, '6', 11, selectedPath)
      const persistence = operationPersistence(execution)
      let durable: LocalHostOperationRecord | undefined
      persistence.replace(async (record) => {
        await persistence.original(record)
        if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
          && record.effectPlan.publication === 'not-started') {
          durable = record
          throw new Error('captured durable Stage plan before lowering the bound')
        }
      })

      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).rejects.toThrow('captured durable Stage plan before lowering the bound')
      persistence.restore()
      if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const pin = durable.effectPlan.pin
      if (durable.effectPlan.expectedIndexFile.kind !== 'file') throw new Error('test retained no source index')
      const loweredBound = durable.effectPlan.expectedIndexFile.byteLength
      expect(loweredBound).toBeGreaterThanOrEqual(MIN_OPERATION_MAX_INDEX_BYTES)
      expect(pin.byteLength).toBeGreaterThan(loweredBound)
      const runtime = execution as unknown as { config: { operationMaxIndexBytes: number } }
      const originalBound = runtime.config.operationMaxIndexBytes
      runtime.config.operationMaxIndexBytes = loweredBound
      const lockPath = join(root, '.git', 'index.lock')
      const pinBytes = await readFile(pin.path)
      if (lockState === 'foreign') {
        await writeFile(lockPath, pinBytes, { flag: 'wx', mode: pin.mode })
        const foreign = await stat(lockPath, { bigint: true })
        expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).not.toEqual(pin.identity)
      }

      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'canceled', effect: 'none' })
      if (lockState === 'absent') {
        await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        await expect(readFile(lockPath)).resolves.toEqual(pinBytes)
      }
      await expect(stat(pin.path)).rejects.toMatchObject({ code: 'ENOENT' })

      expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
        state: 'canceled',
      })
      await expect(stat(pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      runtime.config.operationMaxIndexBytes = originalBound
      if (lockState === 'foreign') await unlink(lockPath)
    },
    60_000,
  )

  it('removes an undurable scratch when its owner sync fails', async () => {
    const root = await repository()
    const failure = new Error('injected scratch owner sync failure')
    const state: { scratchPath?: string; injected: boolean } = { injected: false }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (flags !== 'wx' || basename(path) !== 'owner' || state.injected) return handle
        state.scratchPath = dirname(path)
        return {
          ...handle,
          async sync() {
            await handle.sync()
            state.injected = true
            throw failure
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toBe(failure)

    expect(state.injected).toBe(true)
    if (state.scratchPath === undefined) throw new Error('test retained no failed scratch path')
    await expect(stat(state.scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'planning',
      revision: 2,
    })
    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
  }, 60_000)

  it('removes an undurable scratch when payload initialization fails', async () => {
    const root = await repository()
    const state: { scratchPath?: string; scratchReads: number; injected: boolean } = {
      scratchReads: 0,
      injected: false,
    }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async lstat(path) {
        const info = await localGitMutationNodeAdapter.lstat(path)
        if (!state.injected && basename(path).startsWith('saki-host-operation-')
          && !basename(path).includes('.cleanup-') && info.isDirectory()) {
          state.scratchReads += 1
          if (state.scratchReads === 2) {
            state.injected = true
            state.scratchPath = path
            await writeFile(join(path, 'payload'), 'injected payload collision\n', { flag: 'wx' })
          }
        }
        return info
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toMatchObject({ code: 'EEXIST' })

    expect(state.injected).toBe(true)
    if (state.scratchPath === undefined) throw new Error('test retained no failed scratch path')
    await expect(stat(state.scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'planning',
      revision: 2,
    })
    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
  }, 60_000)

  it('removes a Stage scratch when the first effect-plan persistence fails', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const persistence = operationPersistence(execution)
    let scratchPath: string | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started'
        && (record.effectPlan.kind === 'index' || record.effectPlan.kind === 'commit')) {
        scratchPath = record.effectPlan.scratch.path
        throw new Error('simulated first Stage plan persistence failure')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated first Stage plan persistence failure')
    persistence.restore()
    expect(scratchPath).toBeDefined()
    if (scratchPath === undefined) return
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('surfaces a Stage pin cleanup failure when the first effect plan is not durable', async () => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const lockPath = `${indexPath}.lock`
    const originalIndex = await readFile(indexPath)
    const originalIndexInfo = await stat(indexPath, { bigint: true })
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const persistenceFailure = new Error('injected undurable Stage plan persistence failure')
    const cleanupFailure = Object.assign(new Error('injected undurable Stage pin cleanup failure'), {
      code: 'EACCES',
      errno: -13,
      syscall: 'unlink',
    })
    const state = {
      injectCleanupFailure: true,
      pinRemovals: 0,
      lockLinks: 0,
      indexPublications: 0,
    }
    let plan: Extract<NonNullable<LocalHostOperationRecord['effectPlan']>, { readonly kind: 'index' }>
      | undefined
    let pinRemovalOptions: { readonly recursive?: boolean; readonly force: boolean } | undefined
    let quarantinePath: string | undefined
    let witnessPath: string | undefined
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async rm(path, options) {
        if (state.injectCleanupFailure && plan !== undefined && path === plan.pin.path) {
          pinRemovalOptions = { ...options }
          if (!options.force && options.recursive !== true) {
            state.injectCleanupFailure = false
            state.pinRemovals += 1
            throw cleanupFailure
          }
        }
        await localGitMutationNodeAdapter.rm(path, options)
      },
      async link(from, to) {
        if (plan !== undefined && from === plan.pin.path && to === lockPath) state.lockLinks += 1
        await localGitMutationNodeAdapter.link(from, to)
      },
      async rename(from, to) {
        if (from === lockPath && to === indexPath) state.indexPublications += 1
        await localGitMutationNodeAdapter.rename(from, to)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '7', 12)
    const persistence = operationPersistence(execution)
    let planPersists = 0
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
        && record.effectPlan.publication === 'not-started') {
        planPersists += 1
        plan = record.effectPlan
        quarantinePath = `${record.effectPlan.scratch.path}.cleanup-${record.effectPlan.scratch.markerDigest.slice(0, 32)}`
        witnessPath = `${quarantinePath}.owner`
        for (const path of [record.effectPlan.scratch.path, quarantinePath, witnessPath]) {
          if (!roots.includes(path)) roots.push(path)
        }
        throw persistenceFailure
      }
      await persistence.original(record)
    })

    try {
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).rejects.toBe(cleanupFailure)
    } finally {
      persistence.restore()
    }

    expect(planPersists).toBe(1)
    if (plan === undefined) throw new Error('test retained no undurable Stage plan')
    expect(state).toEqual({
      injectCleanupFailure: false,
      pinRemovals: 1,
      lockLinks: 0,
      indexPublications: 0,
    })
    expect(pinRemovalOptions).toEqual({ force: false })
    await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    if (quarantinePath === undefined || witnessPath === undefined) {
      throw new Error('test retained no undurable Stage cleanup paths')
    }
    await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const pinInfo = await stat(plan.pin.path, { bigint: true })
    expect(pinInfo.isFile()).toBe(true)
    expect({ device: pinInfo.dev.toString(), inode: pinInfo.ino.toString() }).toEqual(plan.pin.identity)
    const pinBytes = await readFile(plan.pin.path)
    expect(pinBytes.byteLength).toBe(plan.pin.byteLength)
    expect(createHash('sha256').update(pinBytes).digest('hex')).toBe(plan.pin.digest)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'planning',
      revision: 2,
    })
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    const finalIndexInfo = await stat(indexPath, { bigint: true })
    expect({ device: finalIndexInfo.dev.toString(), inode: finalIndexInfo.ino.toString() }).toEqual({
      device: originalIndexInfo.dev.toString(),
      inode: originalIndexInfo.ino.toString(),
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

    await rm(plan.pin.path, { force: false })
    await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 90_000)

  it('keeps a staged blob private until its durable publication plan exists', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const objectId = await gitText(root, 'hash-object', '--no-filters', 'tracked.txt')
    await expect(run('git', ['cat-file', '-e', objectId], {
      cwd: root,
      windowsHide: true,
    })).rejects.toBeDefined()
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
        throw new Error('simulated crash after durable private Stage plan')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash after durable private Stage plan')
    persistence.restore()
    await expect(run('git', ['cat-file', '-e', objectId], {
      cwd: root,
      windowsHide: true,
    })).rejects.toBeDefined()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable index plan')
    expect(durable.effectPlan).toHaveProperty('pin')
    const pin = durable.effectPlan.pin
    const pinInfo = await stat(pin.path, { bigint: true })
    expect({ device: pinInfo.dev.toString(), inode: pinInfo.ino.toString() }).toEqual(pin.identity)
    expect(pin.digest).toBe(durable.effectPlan.targetIndexFile.digest)
    expect(pin.byteLength).toBe(durable.effectPlan.targetIndexFile.byteLength)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    await expect(run('git', ['cat-file', '-e', objectId], { cwd: root, windowsHide: true })).resolves.toBeDefined()
  }, 60_000)

  it('never trusts a durable scratch path outside the operation-owned temporary range', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
      }
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated crash before scratch recovery')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash before scratch recovery')
    persistence.restore()
    if (durable?.effectPlan === undefined
      || (durable.effectPlan.kind !== 'index' && durable.effectPlan.kind !== 'commit')) {
      throw new Error('test did not retain a Git effect plan')
    }
    const gitDurable = durable as LocalHostStructuredGitOperationRecord
    if (gitDurable.effectPlan === undefined) throw new Error('test did not retain a Git effect plan')
    roots.push(gitDurable.effectPlan.scratch.path)
    const unrelated = await mkdtemp(join(tmpdir(), 'saki-unrelated-temporary-'))
    roots.push(unrelated)
    const marker = await readFile(join(gitDurable.effectPlan.scratch.path, 'owner'))
    await writeFile(join(unrelated, 'owner'), marker)
    await persistence.original({
      ...gitDurable,
      effectPlan: {
        ...gitDurable.effectPlan,
        scratch: { ...gitDurable.effectPlan.scratch, path: unrelated },
      },
    })

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none' })
    await expect(readFile(join(unrelated, 'owner'))).resolves.toEqual(marker)
  }, 45_000)

  it('bounds durable index-plan path evidence before structural parsing', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { durable } = await captureDurableNotStartedStage(execution, root, signal, 'a', 101)
    if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable index plan')

    let elementReads = 0
    const oversizedChanges = new Proxy(
      new Array<unknown>(MAX_HOST_OPERATION_SELECTED_CHANGES + 1),
      {
        get(target, property, receiver): unknown {
          if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/u.test(property)) {
            elementReads += 1
            throw new Error('durable index-plan row limit read an element')
          }
          return Reflect.get(target, property, receiver) as unknown
        },
      },
    )
    let oversizedIssues = ''
    expect(() => {
      oversizedIssues = operationRecordIssueDetails({
        ...durable,
        effectPlan: { ...durable.effectPlan, changes: oversizedChanges },
      })
    }).not.toThrow()
    expect(oversizedIssues).toContain('index effect plan changes exceed the protocol row limit')
    expect(elementReads).toBe(0)

    const exactRowSentinel = new Error('exact durable index-plan row boundary reached its first element')
    let exactRowReads = 0
    const exactRowChanges = new Proxy(
      new Array<unknown>(MAX_HOST_OPERATION_SELECTED_CHANGES),
      {
        get(target, property, receiver): unknown {
          if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/u.test(property)) {
            exactRowReads += 1
            throw exactRowSentinel
          }
          return Reflect.get(target, property, receiver) as unknown
        },
      },
    )
    expect(() => operationRecordIssueDetails({
      ...durable,
      effectPlan: { ...durable.effectPlan, changes: exactRowChanges },
    })).toThrow(exactRowSentinel)
    expect(exactRowReads).toBe(1)

    expect(operationRecordIssueDetails({
      ...durable,
      effectPlan: { ...durable.effectPlan, changes: [] },
    })).toContain('index effect plan must contain at least one change')

    const firstChange = durable.effectPlan.changes[0]
    if (firstChange === undefined) throw new Error('test durable index plan retained no change')
    for (const structurallyInvalidChange of [
      null,
      { ...firstChange, path: 1 },
      { ...firstChange, pathBytesBase64: 1 },
    ]) {
      expect(operationRecordIssueDetails({
        ...durable,
        effectPlan: { ...durable.effectPlan, changes: [structurallyInvalidChange] },
      })).not.toBe('')
    }
    const exactPath = 'a'.repeat(MAX_PROJECT_GIT_STATUS_PATH_BYTES)
    const oversizedPath = `${exactPath}a`
    let pathEvidenceReads = 0
    const oversizedPathChange = new Proxy({ ...firstChange, path: oversizedPath }, {
      get(target, property, receiver): unknown {
        if (property === 'pathBytesBase64') {
          pathEvidenceReads += 1
          throw new Error('durable index-plan path limit read later evidence')
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    let oversizedPathIssues = ''
    expect(() => {
      oversizedPathIssues = operationRecordIssueDetails({
        ...durable,
        effectPlan: { ...durable.effectPlan, changes: [oversizedPathChange] },
      })
    }).not.toThrow()
    expect(oversizedPathIssues).toContain('index effect plan paths exceed the protocol byte limit')
    expect(pathEvidenceReads).toBe(0)

    const oversizedUtf8Path = '界'.repeat(Math.floor(MAX_PROJECT_GIT_STATUS_PATH_BYTES / 3) + 1)
    expect(oversizedUtf8Path.length).toBeLessThanOrEqual(MAX_PROJECT_GIT_STATUS_PATH_BYTES)
    let utf8PathEvidenceReads = 0
    const oversizedUtf8PathChange = new Proxy({ ...firstChange, path: oversizedUtf8Path }, {
      get(target, property, receiver): unknown {
        if (property === 'pathBytesBase64') {
          utf8PathEvidenceReads += 1
          throw new Error('durable index-plan UTF-8 limit read later evidence')
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    let oversizedUtf8PathIssues = ''
    expect(() => {
      oversizedUtf8PathIssues = operationRecordIssueDetails({
        ...durable,
        effectPlan: { ...durable.effectPlan, changes: [oversizedUtf8PathChange] },
      })
    }).not.toThrow()
    expect(oversizedUtf8PathIssues).toContain('index effect plan paths exceed the protocol byte limit')
    expect(utf8PathEvidenceReads).toBe(0)

    const exactPathIssues = operationRecordIssueDetails({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        changes: [{ path: exactPath, pathBytesBase64: 'YQ==' }],
      },
    })
    expect(exactPathIssues).not.toContain('index effect plan paths exceed the protocol byte limit')

    let aggregatePathEvidenceReads = 0
    const aggregatePathOverflow = new Proxy({ path: 'b', pathBytesBase64: 'Yg==' }, {
      get(target, property, receiver): unknown {
        if (property === 'pathBytesBase64') {
          aggregatePathEvidenceReads += 1
          throw new Error('durable index-plan path aggregate read later evidence')
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    let aggregatePathIssues = ''
    expect(() => {
      aggregatePathIssues = operationRecordIssueDetails({
        ...durable,
        effectPlan: {
          ...durable.effectPlan,
          changes: [
            { path: exactPath, pathBytesBase64: 'YQ==' },
            aggregatePathOverflow,
          ],
        },
      })
    }).not.toThrow()
    expect(aggregatePathIssues).toContain('index effect plan paths exceed the protocol byte limit')
    expect(aggregatePathEvidenceReads).toBe(0)

    const exactPathBytesBase64 = zeroBytesBase64(MAX_PROJECT_GIT_STATUS_PATH_BYTES)
    const oversizedPathBytesBase64 = `${exactPathBytesBase64}A`
    expect(operationRecordIssueDetails({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        changes: [{ path: 'a', pathBytesBase64: oversizedPathBytesBase64 }],
      },
    })).toContain('index effect plan paths exceed the protocol byte limit')

    const overByOnePathBytesBase64 = zeroBytesBase64(MAX_PROJECT_GIT_STATUS_PATH_BYTES + 1)
    expect(overByOnePathBytesBase64).toHaveLength(exactPathBytesBase64.length)
    let exactBoundaryIssues = ''
    expect(() => {
      exactBoundaryIssues = operationRecordIssueDetails({
        ...durable,
        effectPlan: {
          ...durable.effectPlan,
          changes: [{ path: 'a', pathBytesBase64: exactPathBytesBase64 }],
        },
      })
    }).not.toThrow()
    expect(exactBoundaryIssues).not.toContain('index effect plan paths exceed the protocol byte limit')
    expect(operationRecordIssueDetails({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        changes: [{ path: 'a', pathBytesBase64: overByOnePathBytesBase64 }],
      },
    })).toContain('index effect plan paths exceed the protocol byte limit')

    let unreadableChangeReads = 0
    const unreadableChange = new Proxy({}, {
      get(): never {
        unreadableChangeReads += 1
        throw new Error('durable index-plan aggregate limit read a later change')
      },
    })
    let aggregateIssues = ''
    expect(() => {
      aggregateIssues = operationRecordIssueDetails({
        ...durable,
        effectPlan: {
          ...durable.effectPlan,
          changes: [
            { path: 'a', pathBytesBase64: exactPathBytesBase64 },
            { path: 'b', pathBytesBase64: 'Yg==' },
            unreadableChange,
          ],
        },
      })
    }).not.toThrow()
    expect(aggregateIssues).toContain('index effect plan paths exceed the protocol byte limit')
    expect(unreadableChangeReads).toBe(0)

    for (const invalidBase64 of ['', 'AAA', 'A===', '=AAA', 'AA=A', 'AA!A', 'AB==', 'AAB=']) {
      expect(operationRecordIssueDetails({
        ...durable,
        effectPlan: {
          ...durable.effectPlan,
          changes: [{ path: 'a', pathBytesBase64: invalidBase64 }],
        },
      })).toContain('index effect plan path bytes are not canonical base64')
    }
    for (const canonicalBase64 of ['AQ==', 'AAE=', '+w==', '/w==']) {
      expect(operationRecordIssueDetails({
        ...durable,
        effectPlan: {
          ...durable.effectPlan,
          changes: [{ path: 'a', pathBytesBase64: canonicalBase64 }],
        },
      })).not.toContain('index effect plan path bytes are not canonical base64')
    }

    const escapingPath = '../outside.txt'
    expect(operationRecordIssueDetails({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        changes: [{
          ...firstChange,
          path: escapingPath,
          pathBytesBase64: Buffer.from(escapingPath, 'utf8').toString('base64'),
        }],
      },
    })).toContain('index effect plan path is not a bounded repository-relative Git path')
  }, 90_000)

  it('resumes a durable not-started index publication through its exact owned pin hard link', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selectedPath = `untracked-${'x'.repeat(180)}.txt`
    const { prepared } = await preparedStage(execution, root, signal, '7', 12, selectedPath)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started'
        && (record.effectPlan.kind === 'index' || record.effectPlan.kind === 'commit')) {
        durable = record
      }
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated crash after prepublication index fill')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash after prepublication index fill')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test did not retain an index plan')
    if (durable.snapshot.state !== 'publishing' || durable.request.type !== 'stage-files') {
      throw new Error('test did not retain a publishing Stage plan')
    }
    const operationSchema = sakiHostExecutionDomainSpec.tables.operations.valueSchema
    const firstChange = durable.effectPlan.changes[0]
    const firstResultChange = durable.effectPlan.result.changes[0]
    if (firstChange === undefined) throw new Error('test index plan retained no changes')
    if (firstResultChange === undefined) throw new Error('test index result retained no changes')
    expect(operationSchema.safeParse(durable).success).toBe(true)
    expect(durable.effectPlan.indexReadLimit).toBe(CONFIG.operationMaxIndexBytes)
    const { indexReadLimit: _indexReadLimit, ...planWithoutIndexReadLimit } = durable.effectPlan
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: planWithoutIndexReadLimit,
    }).success).toBe(false)
    expectOperationRecordIssue({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        indexReadLimit: durable.effectPlan.pin.byteLength - 1,
      },
    }, 'index effect plan read limit cannot retain its evidence')
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: { ...durable.effectPlan, indexReadLimit: bufferConstants.MAX_LENGTH + 1 },
    }).success).toBe(false)
    expectOperationRecordIssue({
      ...durable,
      snapshot: {
        ...durable.snapshot,
        requestFingerprint: {
          ...durable.snapshot.requestFingerprint,
          digest: differentHex(durable.snapshot.requestFingerprint.digest),
        },
      },
    }, 'Host Operation request fingerprint disagrees with request')
    for (const snapshot of [
      {
        ...durable.snapshot,
        operation: { ...durable.snapshot.operation, type: 'unstage-files' },
      },
      {
        ...durable.snapshot,
        operation: {
          ...durable.snapshot.operation,
          hostId: 'host-22222222-2222-4222-8222-222222222222',
        },
      },
      {
        ...durable.snapshot,
        bindingId: 'binding-22222222-2222-4222-8222-222222222222',
      },
      {
        ...durable.snapshot,
        bindingRevision: durable.snapshot.bindingRevision + 1,
      },
    ]) {
      expectOperationRecordIssue({ ...durable, snapshot }, 'Host Operation snapshot disagrees with request routing')
    }
    expectOperationRecordIssue({
      ...durable,
      snapshot: {
        ...durable.snapshot,
        source: {
          ...durable.snapshot.source,
          payloadDigest: differentHex(durable.snapshot.source.payloadDigest),
        },
      },
    }, 'Host Operation snapshot disagrees with request source')
    expectOperationRecordIssue({
      ...durable,
      preparationRevision: durable.snapshot.revision + 1,
    }, 'Host Operation preparation revision exceeds current revision')
    const snapshotCore = hostOperationSnapshotCore(durable.snapshot)
    for (const snapshot of [
      { ...snapshotCore, state: 'prepared', admission: { kind: 'not-accepted' } },
      { ...snapshotCore, state: 'accepted' },
      { ...snapshotCore, state: 'planning', plannedAt: snapshotCore.updatedAt },
    ]) {
      expectOperationRecordIssue(
        { ...durable, snapshot },
        `${snapshot.state} Host Operation unexpectedly has an effect plan`,
      )
    }
    const { effectPlan: _ignoredEffectPlan, ...withoutPlan } = durable
    expectOperationRecordIssue(withoutPlan, 'publishing Host Operation has no durable effect plan')
    const reconciliationSnapshot = {
      ...snapshotCore,
      state: 'reconciliation-required',
      observedAt: snapshotCore.updatedAt,
      reason: 'evidence-conflict',
    }
    expectOperationRecordIssue(
      { ...withoutPlan, snapshot: reconciliationSnapshot },
      'reconciliation-required Host Operation has no durable effect plan',
    )
    expectOperationRecordIssue(
      { ...durable, snapshot: reconciliationSnapshot },
      'reconciliation-required Host Operation has no attempted publication',
    )
    for (const snapshot of [
      {
        ...snapshotCore,
        state: 'failed',
        completedAt: snapshotCore.updatedAt,
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
      {
        ...snapshotCore,
        state: 'canceled',
        completedAt: snapshotCore.updatedAt,
        reason: 'source-canceled',
        effect: 'none',
      },
    ]) {
      expectOperationRecordIssue({
        ...durable,
        snapshot,
        effectPlan: { ...durable.effectPlan, publication: 'attempting' },
      }, `${snapshot.state} Host Operation contradicts its no-effect evidence`)
    }
    const agentRunInput = {
      id: '77777777-7777-4777-8777-777777777777',
      role: 'user',
      content: [{ type: 'text', text: 'Cross-kind durable schema probe.' }],
      source: {
        kind: 'saki-agent-run',
        dispatchId: 'dispatch-22222222-2222-4222-8222-222222222222',
        agentRunId: 'agent-run-33333333-3333-4333-8333-333333333333',
        workSessionId: 'work-session-44444444-4444-4444-8444-444444444444',
      },
    } as StartAgentRunInputMessage
    const agentRunRequest = {
      type: 'start-agent-run',
      source: {
        kind: 'execution-dispatch',
        dispatchId: agentRunInput.source.dispatchId,
        payloadDigest: computeStartAgentRunPayloadDigest(agentRunInput),
      },
      expected: durable.request.expected,
      run: {
        agentRunId: agentRunInput.source.agentRunId,
        workSessionId: agentRunInput.source.workSessionId,
        sessionId: 'session-66666666-6666-4666-8666-666666666666',
        profile: {
          id: 'agent-profile-55555555-5555-4555-8555-555555555555',
          version: 1,
          agentPresetId: 'development',
          modelRoute: { provider: 'test-provider', model: 'test-model' },
        },
        input: agentRunInput,
      },
    } as StartAgentRunHostOperationRequest
    const agentRunPlan = {
      kind: 'agent-run' as const,
      publication: 'attempting' as const,
      result: localHostAgentRunResultFor(agentRunRequest),
    }
    const push = pushRequest(durable.request.expected.binding, 'a'.repeat(40), '1')
    const pushPlan = {
      kind: 'push-branch',
      publication: 'not-started',
      result: {
        type: 'push-branch',
        repository: push.expected.repository,
        targetRef: push.targetRef,
        commitId: push.expected.commitId,
        previous: { kind: 'absent' },
        credential: { helperId: 'git-credential-manager' },
      },
    }
    expectOperationRecordIssue({ ...durable, effectPlan: pushPlan },
      'Push effect plan disagrees with Host Operation type')
    expectOperationRecordIssue({ ...durable, request: push, effectPlan: agentRunPlan },
      'Push Host Operation has a different effect plan')
    expectOperationRecordIssue({ ...durable, request: push },
      'Push Host Operation has a different effect plan')
    expectOperationRecordIssue({
      ...durable,
      effectPlan: agentRunPlan,
    }, 'Agent Run effect plan disagrees with Host Operation type')
    const agentRunFingerprint = localHostOperationRequestFingerprint(agentRunRequest)
    expectOperationRecordIssue({
      ...durable,
      request: agentRunRequest,
      snapshot: {
        ...durable.snapshot,
        operation: { ...durable.snapshot.operation, type: 'start-agent-run' },
        source: agentRunRequest.source,
        requestFingerprint: agentRunFingerprint,
      },
    }, 'Agent Run Host Operation has a Git effect plan')
    const { changes: _changes, ...requestBase } = durable.request
    const crossKindRequest: CommitHostOperationRequest = {
      ...requestBase,
      type: 'commit',
      message: 'cross-kind schema probe\n',
    }
    const crossKindFingerprint = localHostOperationRequestFingerprint(crossKindRequest)
    expectOperationRecordIssue({
      ...durable,
      request: crossKindRequest,
      snapshot: {
        ...durable.snapshot,
        operation: { ...durable.snapshot.operation, type: 'commit' },
        requestFingerprint: crossKindFingerprint,
      },
    }, 'index effect plan disagrees with Host Operation type')
    const changedFingerprint = {
      ...firstChange.fingerprint,
      digest: differentHex(firstChange.fingerprint.digest),
    }
    expectOperationRecordIssue({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        changes: [{ ...firstChange, fingerprint: changedFingerprint }],
        result: {
          ...durable.effectPlan.result,
          changes: [{ ...firstResultChange, fingerprint: changedFingerprint }],
        },
      },
    }, 'index effect plan changes disagree with the request selection')
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        changes: [{ ...firstChange, path: `${firstChange.path}-mismatch` }],
      },
    }).success).toBe(false)
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        result: { ...durable.effectPlan.result, changes: [] },
      },
    }).success).toBe(false)
    expectOperationRecordIssue({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        result: {
          ...durable.effectPlan.result,
          resultingIndex: { kind: 'tree', treeId: 'a'.repeat(64) },
        },
      },
    }, 'index effect plan uses a different object format')
    expectOperationRecordIssue({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        pin: { ...durable.effectPlan.pin, digest: differentHex(durable.effectPlan.pin.digest) },
      },
    }, 'index pin evidence disagrees with its target index')
    if (durable.effectPlan.expectedIndexFile.kind !== 'file') {
      throw new Error('test retained no source index evidence')
    }
    expectOperationRecordIssue({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        targetIndexFile: durable.effectPlan.expectedIndexFile,
        pin: {
          ...durable.effectPlan.pin,
          digest: durable.effectPlan.expectedIndexFile.digest,
          byteLength: durable.effectPlan.expectedIndexFile.byteLength,
        },
      },
    }, 'index effect plan has no observable publication')
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        pin: { ...durable.effectPlan.pin, path: join(root, 'tracked.txt') },
      },
    }).success).toBe(false)
    expectOperationRecordIssue({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        scratch: {
          ...durable.effectPlan.scratch,
          markerDigest: differentHex(durable.effectPlan.scratch.markerDigest),
        },
      },
    }, 'effect plan scratch marker disagrees with operation identity')
    const { identity: _scratchIdentity, ...scratchWithoutIdentity } = durable.effectPlan.scratch
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: { ...durable.effectPlan, scratch: scratchWithoutIdentity },
    }).success).toBe(false)
    const {
      payloadIdentity: _scratchPayloadIdentity,
      ...scratchWithoutPayloadIdentity
    } = durable.effectPlan.scratch
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: { ...durable.effectPlan, scratch: scratchWithoutPayloadIdentity },
    }).success).toBe(false)
    const { ownerIdentity: _scratchOwnerIdentity, ...scratchWithoutOwnerIdentity } = durable.effectPlan.scratch
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: { ...durable.effectPlan, scratch: scratchWithoutOwnerIdentity },
    }).success).toBe(false)
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        scratch: {
          ...durable.effectPlan.scratch,
          identity: { ...durable.effectPlan.scratch.identity, device: '-1' },
        },
      },
    }).success).toBe(false)
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        scratch: {
          ...durable.effectPlan.scratch,
          payloadIdentity: { ...durable.effectPlan.scratch.payloadIdentity, device: '-1' },
        },
      },
    }).success).toBe(false)
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        scratch: {
          ...durable.effectPlan.scratch,
          ownerIdentity: { ...durable.effectPlan.scratch.ownerIdentity, inode: '-1' },
        },
      },
    }).success).toBe(false)
    for (const invalidIdentity of [
      '',
      'abc',
      '1e3',
      '+1',
      ' 1',
      '1 ',
      '01',
      '18446744073709551616',
      '100000000000000000000',
    ]) {
      expect(operationSchema.safeParse({
        ...durable,
        effectPlan: {
          ...durable.effectPlan,
          scratch: {
            ...durable.effectPlan.scratch,
            identity: { ...durable.effectPlan.scratch.identity, device: invalidIdentity },
          },
        },
      }).success).toBe(false)
    }
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        pin: { ...durable.effectPlan.pin, byteLength: durable.effectPlan.pin.byteLength + 1 },
      },
    }).success).toBe(false)
    const lockPath = join(root, '.git', 'index.lock')
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await link(durable.effectPlan.pin.path, lockPath)
    const pin = await stat(durable.effectPlan.pin.path, { bigint: true })
    const lock = await stat(lockPath, { bigint: true })
    expect({ device: lock.dev.toString(), inode: lock.ino.toString() }).toEqual({
      device: pin.dev.toString(),
      inode: pin.ino.toString(),
    })

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'publishing',
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    let succeededRecord: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'succeeded') succeededRecord = record
    })
    if (durable.effectPlan.expectedIndexFile.kind !== 'file') throw new Error('test retained no source index')
    const loweredBound = Math.max(
      durable.effectPlan.expectedIndexFile.byteLength,
      MIN_OPERATION_MAX_INDEX_BYTES,
    )
    expect(loweredBound).toBeGreaterThanOrEqual(MIN_OPERATION_MAX_INDEX_BYTES)
    expect(durable.effectPlan.pin.byteLength).toBeGreaterThan(loweredBound)
    const runtime = execution as unknown as { config: { operationMaxIndexBytes: number } }
    const originalBound = runtime.config.operationMaxIndexBytes
    runtime.config.operationMaxIndexBytes = loweredBound
    const resumed = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    ).finally(() => { runtime.config.operationMaxIndexBytes = originalBound })
    persistence.restore()
    expect(resumed).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    if (succeededRecord?.effectPlan?.kind !== 'index') throw new Error('test retained no succeeded index plan')
    const parsedSucceededRecord = operationSchema.safeParse(succeededRecord)
    expect(
      parsedSucceededRecord.success,
      parsedSucceededRecord.success ? undefined : JSON.stringify(parsedSucceededRecord.error.issues),
    ).toBe(true)
    const { effectPlan: _effectPlan, ...missingPlan } = succeededRecord
    expect(operationSchema.safeParse(missingPlan).success).toBe(false)
    expect(operationSchema.safeParse({
      ...succeededRecord,
      effectPlan: { ...succeededRecord.effectPlan, publication: 'attempting' },
    }).success).toBe(false)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe(selectedPath)
  }, 60_000)

  it('recovers an acknowledged-lost index publication from exact target evidence', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selectedPath = `untracked-${'y'.repeat(180)}.txt`
    const { prepared } = await preparedStage(execution, root, signal, '7', 12, selectedPath)
    const persistence = operationPersistence(execution)
    let pinPath: string | undefined
    let scratchPath: string | undefined
    let durablePlan: Extract<NonNullable<LocalHostOperationRecord['effectPlan']>, { readonly kind: 'index' }>
      | undefined
    persistence.replace(async (record) => {
      if (record.effectPlan?.kind === 'index') {
        durablePlan = record.effectPlan
        pinPath = record.effectPlan.pin.path
        scratchPath = record.effectPlan.scratch.path
      }
      if (record.snapshot.state === 'succeeded') {
        await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
        if (pinPath === undefined || scratchPath === undefined) throw new Error('test retained no cleanup resources')
        await expect(stat(pinPath)).resolves.toBeDefined()
        await expect(stat(scratchPath)).resolves.toBeDefined()
        await persistence.original(record)
        throw new Error('simulated durability acknowledgement loss')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated durability acknowledgement loss')
    persistence.restore()
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe(selectedPath)
    if (pinPath === undefined || scratchPath === undefined) throw new Error('test retained no cleanup resources')
    if (durablePlan === undefined || durablePlan.expectedIndexFile.kind !== 'file') {
      throw new Error('test retained no durable index plan')
    }
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()
    const loweredBound = Math.max(
      durablePlan.expectedIndexFile.byteLength,
      MIN_OPERATION_MAX_INDEX_BYTES,
    )
    expect(loweredBound).toBeGreaterThanOrEqual(MIN_OPERATION_MAX_INDEX_BYTES)
    expect(durablePlan.pin.byteLength).toBeGreaterThan(loweredBound)
    const runtime = execution as unknown as { config: { operationMaxIndexBytes: number } }
    const originalBound = runtime.config.operationMaxIndexBytes
    runtime.config.operationMaxIndexBytes = loweredBound

    const recovered = await execution.inspectOperation(
      prepared.preparation.operation,
      signal,
    ).finally(() => { runtime.config.operationMaxIndexBytes = originalBound })
    expect(recovered).toMatchObject({
      state: 'succeeded',
      result: { type: 'stage-files', changes: [{ path: selectedPath }] },
    })
    expect(liveOperationCount(execution)).toBe(0)
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toEqual(recovered)
  }, 45_000)

  it('does not strand an applied Stage when nonblocking pin cleanup cannot prove ownership', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '7', 12)
    const persistence = operationPersistence(execution)
    let pinPath: string | undefined
    let pinBytes: Buffer | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'succeeded' && record.effectPlan?.kind === 'index') {
        pinPath = record.effectPlan.pin.path
        pinBytes = await readFile(pinPath)
        await writeFile(pinPath, Buffer.from([0]), { flag: 'a' })
      }
      await persistence.original(record)
    })

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    persistence.restore()
    if (pinPath === undefined || pinBytes === undefined) throw new Error('test retained no index pin')
    expect((await stat(pinPath)).size).toBe(pinBytes.byteLength + 1)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
    })
    expect((await stat(pinPath)).size).toBe(pinBytes.byteLength + 1)

    await writeFile(pinPath, pinBytes)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
    })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('fails a durable not-started Stage when the worktree drifts before resume', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '8', 13)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
        && record.effectPlan.publication === 'not-started') {
        durable = record
      }
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated crash before resumed Stage publication')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash before resumed Stage publication')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    roots.push(durable.effectPlan.scratch.path)
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const lockPath = join(root, '.git', 'index.lock')
    const originalIndex = await readFile(join(root, '.git', 'index'))
    const foreignLock = Buffer.from('foreign index lock')
    const externalContents = 'external worktree change\n'
    await writeFile(join(root, 'tracked.txt'), externalContents)
    let persistedFailure = false
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'failed') {
        persistedFailure = true
        await writeFile(lockPath, foreignLock, { flag: 'wx' })
      }
      await persistence.original(record)
    })

    const resumed = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    persistence.restore()

    expect(persistedFailure).toBe(true)
    expect(resumed, JSON.stringify(resumed)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'observation-stale' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    await expect(readFile(join(root, '.git', 'index'))).resolves.toEqual(originalIndex)
    await expect(readFile(join(root, 'tracked.txt'), 'utf8')).resolves.toBe(externalContents)
    await expect(readFile(lockPath)).resolves.toEqual(foreignLock)
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await unlink(lockPath)
  }, 60_000)

  it('keeps a durable not-started Stage retryable behind a foreign index lock', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '8', 13)
    if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const indexPath = join(dirname(pinPath), 'index')
    const lockPath = `${indexPath}.lock`
    expect(indexPath).toBe(join(root, '.git', 'index'))
    expect(indexPath).toBe(join(
      durable.request.expected.binding.expectedInspection.trusted.canonicalGitDirectory,
      'index',
    ))
    const originalIndex = await readFile(indexPath)
    const originalHead = await gitText(root, 'rev-parse', 'HEAD')
    const foreignLock = Buffer.from('foreign durable resume lock\n')
    await writeFile(lockPath, foreignLock, { flag: 'wx' })
    const foreignLockInfo = await stat(lockPath, { bigint: true })
    const persistence = operationPersistence(execution)
    let busyRecord: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      busyRecord = record
      await persistence.original(record)
    })

    const busy = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    persistence.restore()

    expect(busy).toMatchObject({ ok: false, reason: 'busy', snapshot: { state: 'publishing' } })
    await expect(readFile(lockPath)).resolves.toEqual(foreignLock)
    const retainedLockInfo = await stat(lockPath, { bigint: true })
    expect({ dev: retainedLockInfo.dev, ino: retainedLockInfo.ino }).toEqual({
      dev: foreignLockInfo.dev,
      ino: foreignLockInfo.ino,
    })
    expect(busy.snapshot.revision).toBe(durable.snapshot.revision)
    expect(busyRecord).toBeUndefined()
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(originalHead)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    await unlink(lockPath)

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it('fails a durable not-started Stage when its owned target index becomes a directory', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '8', 13)
    if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const targetPath = join(scratchPath, 'payload', 'target.index')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const targetBytes = await readFile(targetPath)
    expect(durable.effectPlan.targetIndexFile).toMatchObject({
      digest: createHash('sha256').update(targetBytes).digest('hex'),
      byteLength: targetBytes.byteLength,
    })
    await rm(targetPath)
    await mkdir(targetPath)
    expect((await stat(targetPath)).isDirectory()).toBe(true)

    const resumed = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(resumed).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it.each([
    'initial',
    'resumed',
  ] as const)('keeps a Stage retryable when its private target index disappears during its %s attempt', async (flow) => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const state = {
      armed: false,
      removed: false,
      publishCalls: 0,
      targetPath: undefined as string | undefined,
      scratchPath: undefined as string | undefined,
    }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async lstat(path) {
        if (state.armed && !state.removed && basename(path) === 'target.index') {
          await localGitMutationNodeAdapter.rm(path, { force: false })
          state.targetPath = path
          const scratchPath = dirname(dirname(path))
          state.scratchPath = scratchPath
          if (flow === 'initial') roots.push(scratchPath)
          state.removed = true
        }
        return await localGitMutationNodeAdapter.lstat(path)
      },
      async rename(from, to) {
        if (from === `${indexPath}.lock` && to === indexPath) state.publishCalls += 1
        await localGitMutationNodeAdapter.rename(from, to)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const captured = flow === 'initial'
      ? { ...(await preparedStage(execution, root, signal, '5', 26)), durable: undefined }
      : await captureDurableNotStartedStage(execution, root, signal, '5', 26)
    state.armed = true

    const started = await execution.startOperation(
      captured.prepared.preparation.operation,
      captured.prepared.acceptance,
      signal,
    )

    expect(state).toMatchObject({ armed: true, removed: true, publishCalls: 0 })
    expect(started).toMatchObject({
      ok: false,
      reason: 'unavailable',
      snapshot: { state: flow === 'initial' ? 'planning' : 'publishing' },
    })
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(state.targetPath).toBeDefined()
    await expect(stat(state.targetPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    if (captured.durable?.effectPlan?.kind === 'index') {
      await expect(stat(captured.durable.effectPlan.pin.path)).resolves.toBeDefined()
      await expect(stat(captured.durable.effectPlan.scratch.path)).resolves.toBeDefined()
    } else {
      expect(state.scratchPath).toBeDefined()
      await expect(stat(state.scratchPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }, 90_000)

  it.each([
    'initial',
    'resumed',
  ] as const)('rejects a Stage whose shared index drifts at final validation during its %s attempt', async (flow) => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const state = {
      armed: false,
      indexLstats: 0,
      drifted: false,
      publishCalls: 0,
      externalIndex: undefined as Buffer | undefined,
      scratchPath: undefined as string | undefined,
    }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async lstat(path) {
        if (state.scratchPath === undefined && basename(path) === 'target.index') {
          const scratchPath = dirname(dirname(path))
          state.scratchPath = scratchPath
          if (flow === 'initial') roots.push(scratchPath)
        }
        if (path === indexPath && state.armed) {
          state.indexLstats += 1
          const trigger = flow === 'initial' ? 1 : 3
          if (!state.drifted && state.indexLstats === trigger) {
            await writeFile(path, Buffer.from([0x78]), { flag: 'a' })
            state.externalIndex = await readFile(path)
            state.drifted = true
          }
        }
        return await localGitMutationNodeAdapter.lstat(path)
      },
      async rename(from, to) {
        if (from === `${indexPath}.lock` && to === indexPath) state.publishCalls += 1
        await localGitMutationNodeAdapter.rename(from, to)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const captured = flow === 'initial'
      ? { ...(await preparedStage(execution, root, signal, '5', 26)), durable: undefined }
      : await captureDurableNotStartedStage(execution, root, signal, '5', 26)
    const originalGitEntries = flow === 'initial' ? (await readdir(join(root, '.git'))).sort() : undefined
    const persistence = operationPersistence(execution)
    if (flow === 'initial') {
      persistence.replace(async (record) => {
        await persistence.original(record)
        if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
          && record.effectPlan.publication === 'not-started') state.armed = true
      })
    } else {
      state.armed = true
    }

    const started = await execution.startOperation(
      captured.prepared.preparation.operation,
      captured.prepared.acceptance,
      signal,
    )
    persistence.restore()

    expect(state.drifted).toBe(true)
    expect(state.publishCalls).toBe(0)
    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'observation-stale' },
        effect: 'none',
      },
    })
    expect(state.externalIndex).toEqual(Buffer.concat([originalIndex, Buffer.from([0x78])]))
    await expect(readFile(indexPath)).resolves.toEqual(state.externalIndex)
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    if (captured.durable?.effectPlan?.kind === 'index') {
      await expect(stat(captured.durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(captured.durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(state.scratchPath).toBeDefined()
      await expect(stat(state.scratchPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(join(root, '.git'))).sort()).toEqual(originalGitEntries)
    }
  }, 90_000)

  it.each([
    { flow: 'initial', artifact: 'pin' },
    { flow: 'initial', artifact: 'lock' },
    { flow: 'resumed', artifact: 'pin' },
    { flow: 'resumed', artifact: 'lock' },
  ] as const)(
    'preserves a foreign $artifact replacement before an $flow Stage publication',
    async ({ flow, artifact }) => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const originalIndex = await readFile(indexPath)
      const state = {
        armed: false,
        replaced: false,
        publishCalls: 0,
        foreignPath: undefined as string | undefined,
        retainedOriginalPath: undefined as string | undefined,
        foreignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async link(from, to) {
          await localGitMutationNodeAdapter.link(from, to)
          if (artifact === 'lock' && state.armed && !state.replaced && to === lockPath) {
            await replaceFileWithSameContents(state, to)
          }
        },
        async rename(from, to) {
          if (from === lockPath && to === indexPath) state.publishCalls += 1
          await localGitMutationNodeAdapter.rename(from, to)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      let durable: LocalHostOperationRecord | undefined
      let prepared: Awaited<ReturnType<typeof preparedStage>>['prepared']
      const persistence = operationPersistence(execution)
      if (flow === 'initial') {
        prepared = (await preparedStage(execution, root, signal, '5', 26)).prepared
        persistence.replace(async (record) => {
          await persistence.original(record)
          if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
            && record.effectPlan.publication === 'not-started') {
            durable = record
            roots.push(record.effectPlan.scratch.path)
            if (artifact === 'pin') await replaceFileWithSameContents(state, record.effectPlan.pin.path)
            else state.armed = true
          }
        })
      } else {
        const captured = await captureDurableNotStartedStage(execution, root, signal, '5', 26)
        prepared = captured.prepared
        durable = captured.durable
        if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
        if (artifact === 'pin') await replaceFileWithSameContents(state, durable.effectPlan.pin.path)
        else state.armed = true
      }

      const started = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )
      persistence.restore()

      if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const foreignPath = state.foreignPath
      const retainedOriginalPath = state.retainedOriginalPath
      if (foreignPath === undefined || retainedOriginalPath === undefined) {
        throw new Error('test did not replace the selected Index artifact')
      }
      expect(state.replaced).toBe(true)
      expect(state.publishCalls).toBe(0)
      expect(state.foreignIdentity).not.toEqual(durable.effectPlan.pin.identity)
      expect(started).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      await expect(stat(foreignPath)).resolves.toBeDefined()
      await expect(stat(retainedOriginalPath)).resolves.toBeDefined()
      await expect(stat(durable.effectPlan.pin.path)).resolves.toBeDefined()
      await expect(stat(durable.effectPlan.scratch.path)).resolves.toBeDefined()
      if (artifact === 'pin') await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    },
    120_000,
  )

  it.each([
    'initial',
    'resumed',
  ] as const)('releases a Stage lock when attempting persistence fails during its %s attempt', async (flow) => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const indexPath = join(root, '.git', 'index')
    const lockPath = `${indexPath}.lock`
    const originalIndex = await readFile(indexPath)
    let durable: LocalHostOperationRecord | undefined
    let prepared: Awaited<ReturnType<typeof preparedStage>>['prepared']
    if (flow === 'initial') {
      prepared = (await preparedStage(execution, root, signal, '5', 26)).prepared
    } else {
      const captured = await captureDurableNotStartedStage(execution, root, signal, '5', 26)
      prepared = captured.prepared
      durable = captured.durable
    }
    const sentinel = new Error(`injected ${flow} Stage attempting persistence failure`)
    const persistence = operationPersistence(execution)
    let injected = false
    persistence.replace(async (record) => {
      if (!injected && record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
        && record.effectPlan.publication === 'attempting') {
        injected = true
        const lock = await stat(lockPath, { bigint: true })
        expect({ device: lock.dev.toString(), inode: lock.ino.toString() }).toEqual(
          record.effectPlan.pin.identity,
        )
        throw sentinel
      }
      await persistence.original(record)
      if (durable === undefined && record.snapshot.state === 'publishing'
        && record.effectPlan?.kind === 'index' && record.effectPlan.publication === 'not-started') {
        durable = record
        roots.push(record.effectPlan.scratch.path)
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toBe(sentinel)
    persistence.restore()

    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    expect(injected).toBe(true)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).resolves.toBeDefined()
    await expect(stat(durable.effectPlan.scratch.path)).resolves.toBeDefined()
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'publishing',
      revision: durable.snapshot.revision,
    })

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)

  it('preserves an externally changed index when durable not-started recovery sees third evidence', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '8', 13)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
        && record.effectPlan.publication === 'not-started') durable = record
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('captured durable Stage before third index evidence')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('captured durable Stage before third index evidence')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    await writeFile(join(root, 'external.txt'), 'external staged evidence\n')
    await git(root, 'add', '--', 'external.txt')
    const externalIndex = await readFile(join(root, '.git', 'index'))

    const recovered = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(recovered).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'observation-stale' },
        effect: 'none',
      },
    })
    await expect(readFile(join(root, '.git', 'index'))).resolves.toEqual(externalIndex)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('external.txt')
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('rejects a durable not-started Commit after its selected worktree drifts', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution,
      root,
      signal,
      'd',
      18,
      'durable Commit candidate\n',
      'reject stale durable Commit\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const externalContents = 'external worktree drift after durable Commit planning\n'
    await writeFile(join(root, 'tracked.txt'), externalContents)

    const resumed = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(resumed).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'observation-stale' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(readFile(join(root, 'tracked.txt'), 'utf8')).resolves.toBe(externalContents)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it('keeps a durable not-started Commit retryable when cancel cannot read its target', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution,
      root,
      signal,
      'e',
      19,
      'cancel retry candidate\n',
      'retry transient cancel\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const revision = durable.snapshot.revision
    const runner = mutationRunner(execution)
    let rejectedTargetReads = 0
    runner.replaceRun(async (...args) => {
      const [, command] = args
      if (command[0] === 'rev-parse' && command[1] === '--verify'
        && command[2] === '--end-of-options') {
        rejectedTargetReads += 1
        throw new GitCommandError('spawn-failure')
      }
      return await runner.originalRun(...args)
    })

    const first = await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )

    expect(rejectedTargetReads).toBeGreaterThan(0)
    expect(first).toMatchObject({ state: 'publishing', revision })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()

    runner.restore()
    const second = await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )
    expect(second).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it('preserves abort identity while cancel reads a durable Commit target', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const setupSignal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution,
      root,
      setupSignal,
      'f',
      20,
      'aborted cancel candidate\n',
      'preserve abort identity\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const controller = new AbortController()
    const reason = new Error('cancel target read aborted by caller')
    const runner = mutationRunner(execution)
    let abortedTargetRead = false
    runner.replaceRun(async (...args) => {
      const [, command] = args
      if (!abortedTargetRead && command[0] === 'rev-parse' && command[1] === '--verify'
        && command[2] === '--end-of-options') {
        abortedTargetRead = true
        controller.abort(reason)
      }
      return await runner.originalRun(...args)
    })

    await expect(execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      controller.signal,
    )).rejects.toBe(reason)
    runner.restore()

    expect(abortedTargetRead).toBe(true)
    const freshSignal = new AbortController().signal
    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      freshSignal,
    )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()

    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      freshSignal,
    )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it('preserves abort identity when durable Commit target inspection also fails', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const setupSignal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution,
      root,
      setupSignal,
      '0',
      25,
      'aborted resume candidate\n',
      'prefer abort over inspection failure\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const controller = new AbortController()
    const reason = new Error('durable Commit resume aborted by caller')
    const runner = mutationRunner(execution)
    let abortedTargetRead = false
    runner.replaceRun(async (...args) => {
      const [, command] = args
      if (!abortedTargetRead && command[0] === 'rev-parse' && command[1] === '--verify'
        && command[2] === '--end-of-options') {
        abortedTargetRead = true
        controller.abort(reason)
        throw new GitCommandError('spawn-failure')
      }
      return await runner.originalRun(...args)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      controller.signal,
    )).rejects.toBe(reason)
    runner.restore()

    expect(abortedTargetRead).toBe(true)
    const freshSignal = new AbortController().signal
    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      freshSignal,
    )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      freshSignal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it.each([
    'scratch-owner-replaced',
    'pin-replaced',
    'pin-missing',
  ] as const)('refuses durable Commit recovery when %s loses ownership', async (scenario) => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution,
      root,
      signal,
      'a',
      21,
      'ownership refusal candidate\n',
      'refuse foreign durable artifacts\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const ownerPath = join(scratchPath, 'owner')
    const originalOwner = await readFile(ownerPath)
    const originalOwnerInfo = await stat(ownerPath, { bigint: true })
    const originalPin = await readFile(pinPath)
    const originalPinInfo = await stat(pinPath, { bigint: true })
    const foreignOwner = Buffer.from('foreign scratch owner\n')
    let replacementInfo: Awaited<ReturnType<typeof stat>> | undefined

    if (scenario === 'scratch-owner-replaced') {
      await rename(ownerPath, join(scratchPath, 'retained-original-owner'))
      await writeFile(ownerPath, foreignOwner, { flag: 'wx' })
      replacementInfo = await stat(ownerPath, { bigint: true })
      expect(replacementInfo.ino).not.toBe(originalOwnerInfo.ino)
    } else if (scenario === 'pin-replaced') {
      await rename(pinPath, `${pinPath}.retained-original`)
      await writeFile(pinPath, originalPin, {
        flag: 'wx',
        mode: Number(originalPinInfo.mode & 0o777n),
      })
      replacementInfo = await stat(pinPath, { bigint: true })
      expect(replacementInfo.ino).not.toBe(originalPinInfo.ino)
    } else {
      await unlink(pinPath)
    }

    const resumed = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(resumed).toMatchObject({
      ok: false,
      reason: 'unavailable',
      snapshot: { state: 'publishing', revision: durable.snapshot.revision },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).resolves.toBeDefined()
    if (scenario === 'scratch-owner-replaced') {
      await expect(readFile(ownerPath)).resolves.toEqual(foreignOwner)
      const retained = await stat(ownerPath, { bigint: true })
      expect({ dev: retained.dev, ino: retained.ino }).toEqual({
        dev: replacementInfo?.dev,
        ino: replacementInfo?.ino,
      })
      await expect(readFile(pinPath)).resolves.toEqual(originalPin)
    } else if (scenario === 'pin-replaced') {
      await expect(readFile(ownerPath)).resolves.toEqual(originalOwner)
      await expect(readFile(pinPath)).resolves.toEqual(originalPin)
      const retained = await stat(pinPath, { bigint: true })
      expect({ dev: retained.dev, ino: retained.ino, mode: retained.mode & 0o777n }).toEqual({
        dev: replacementInfo?.dev,
        ino: replacementInfo?.ino,
        mode: originalPinInfo.mode & 0o777n,
      })
    } else {
      await expect(readFile(ownerPath)).resolves.toEqual(originalOwner)
      await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }, 75_000)

  it('preserves a same-marker foreign directory that replaces a durable Commit scratch', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution,
      root,
      signal,
      'a',
      22,
      'scratch replacement candidate\n',
      'preserve a rebound scratch path\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const scratchPath = durable.effectPlan.scratch.path
    const pinPath = durable.effectPlan.pin.path
    const owner = await readFile(join(scratchPath, 'owner'))
    const ownedDirectory = await stat(scratchPath, { bigint: true })
    expect(durable.effectPlan.scratch.identity).toEqual({
      device: ownedDirectory.dev.toString(),
      inode: ownedDirectory.ino.toString(),
    })
    const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-scratch-holding-'))
    roots.push(holdingRoot)
    await rename(scratchPath, join(holdingRoot, 'owned'))
    await mkdir(scratchPath, { mode: 0o700 })
    await writeFile(join(scratchPath, 'owner'), owner, { flag: 'wx', mode: 0o600 })
    const sentinelPath = join(scratchPath, 'foreign-sentinel')
    const sentinel = Buffer.from('foreign scratch contents\n')
    await writeFile(sentinelPath, sentinel, { flag: 'wx', mode: 0o600 })
    const replacement = await stat(scratchPath, { bigint: true })
    expect({ dev: replacement.dev, ino: replacement.ino }).not.toEqual({
      dev: ownedDirectory.dev,
      ino: ownedDirectory.ino,
    })

    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

    const retained = await stat(scratchPath, { bigint: true })
    expect({ dev: retained.dev, ino: retained.ino }).toEqual({
      dev: replacement.dev,
      ino: replacement.ino,
    })
    await expect(readFile(join(scratchPath, 'owner'))).resolves.toEqual(owner)
    await expect(readFile(sentinelPath)).resolves.toEqual(sentinel)
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it('rechecks a quarantined Commit scratch before payload cleanup', async () => {
    const root = await repository()
    const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-scratch-race-'))
    roots.push(holdingRoot)
    const ownedStash = join(holdingRoot, 'owned')
    const sentinel = Buffer.from('foreign scratch race contents\n')
    const cleanupTarget: { path?: string; owner?: Buffer } = {}
    let replacementIdentity: { readonly device: bigint; readonly inode: bigint } | undefined
    let injected = false
    const recursiveRemovals: string[] = []
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async rename(from, to) {
        if (!injected && cleanupTarget.path !== undefined && cleanupTarget.owner !== undefined
          && from === cleanupTarget.path && to.startsWith(`${cleanupTarget.path}.cleanup-`)) {
          injected = true
          await localGitMutationNodeAdapter.rename(from, ownedStash)
          await mkdir(from, { mode: 0o700 })
          await writeFile(join(from, 'owner'), cleanupTarget.owner, { flag: 'wx', mode: 0o600 })
          await writeFile(join(from, 'foreign-sentinel'), sentinel, { flag: 'wx', mode: 0o600 })
          const replacement = await localGitMutationNodeAdapter.lstat(from)
          replacementIdentity = { device: replacement.dev, inode: replacement.ino }
        }
        await localGitMutationNodeAdapter.rename(from, to)
      },
      async rm(path, options) {
        if (options.recursive === true) recursiveRemovals.push(path)
        await localGitMutationNodeAdapter.rm(path, options)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution,
      root,
      signal,
      'a',
      23,
      'scratch race candidate\n',
      'recheck quarantined scratch ownership\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const scratchPath = durable.effectPlan.scratch.path
    const owner = await readFile(join(scratchPath, 'owner'))
    cleanupTarget.path = scratchPath
    cleanupTarget.owner = owner

    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

    expect(injected).toBe(true)
    expect(recursiveRemovals).toEqual([])
    const retained = await stat(scratchPath, { bigint: true })
    expect({ device: retained.dev, inode: retained.ino }).toEqual(replacementIdentity)
    await expect(readFile(join(scratchPath, 'owner'))).resolves.toEqual(owner)
    await expect(readFile(join(scratchPath, 'foreign-sentinel'))).resolves.toEqual(sentinel)
    await expect(stat(ownedStash)).resolves.toBeDefined()
  }, 75_000)

  it('preserves a scratch whose owner pathname is replaced during its bounded read', async () => {
    const root = await repository()
    const state: {
      armed: boolean
      ownerBytes?: Buffer
      ownerPath?: string
      retainedOwnerPath?: string
      replaced: boolean
      recursiveRemovals: string[]
    } = { armed: false, replaced: false, recursiveRemovals: [] }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (!state.armed || path !== state.ownerPath || flags !== 'r') return handle
        return {
          ...handle,
          async stat() {
            const observed = await handle.stat()
            if (!state.replaced) {
              state.replaced = true
              state.retainedOwnerPath = `${path}.retained`
              await rename(path, state.retainedOwnerPath)
              if (state.ownerBytes === undefined) throw new Error('test retained no scratch owner bytes')
              await writeFile(path, state.ownerBytes, { flag: 'wx', mode: 0o600 })
            }
            return observed
          },
        }
      },
      async rm(path, options) {
        if (options.recursive === true) state.recursiveRemovals.push(path)
        await localGitMutationNodeAdapter.rm(path, options)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'a', 24)
    if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    const scratchPath = durable.effectPlan.scratch.path
    state.ownerPath = join(scratchPath, 'owner')
    state.ownerBytes = await readFile(state.ownerPath)
    const originalOwner = await stat(state.ownerPath, { bigint: true })
    state.armed = true

    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

    expect(state.replaced).toBe(true)
    expect(state.recursiveRemovals).toEqual([])
    if (state.retainedOwnerPath === undefined) throw new Error('test retained no original owner pathname')
    const replacement = await stat(state.ownerPath, { bigint: true })
    expect({ device: replacement.dev, inode: replacement.ino }).not.toEqual({
      device: originalOwner.dev,
      inode: originalOwner.ino,
    })
    await expect(readFile(state.ownerPath)).resolves.toEqual(state.ownerBytes)
    await expect(readFile(state.retainedOwnerPath)).resolves.toEqual(state.ownerBytes)
    await expect(stat(join(scratchPath, 'payload'))).resolves.toBeDefined()
  }, 75_000)

  it('retries durable Commit scratch cleanup from its quarantine path', async () => {
    const root = await repository()
    const cleanupTarget: {
      scratchPath?: string
      quarantinePath?: string
      replayArmed: boolean
      replayRemovals: Array<{ readonly path: string; readonly recursive: boolean; readonly force: boolean | undefined }>
      replayUnlinks: string[]
      replayRmdirs: string[]
      replayRenames: Array<{ readonly from: string; readonly to: string }>
    } = {
      replayArmed: false,
      replayRemovals: [],
      replayUnlinks: [],
      replayRmdirs: [],
      replayRenames: [],
    }
    let removalFailed = false
    let restoreFailed = false
    const removalFailure = new Error('injected scratch quarantine removal failure')
    const restoreFailure = new Error('injected scratch quarantine restore failure')
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async rename(from, to) {
        if (cleanupTarget.scratchPath !== undefined && from === cleanupTarget.scratchPath
          && to.startsWith(`${cleanupTarget.scratchPath}.cleanup-`)) {
          cleanupTarget.quarantinePath = to
          roots.push(to, `${to}.owner`)
        } else if (cleanupTarget.quarantinePath !== undefined
          && from === `${cleanupTarget.quarantinePath}.owner`
          && to === join(cleanupTarget.quarantinePath, 'owner')
          && !restoreFailed) {
          restoreFailed = true
          throw restoreFailure
        }
        if (cleanupTarget.replayArmed) cleanupTarget.replayRenames.push({ from, to })
        await localGitMutationNodeAdapter.rename(from, to)
      },
      async readdir(path) {
        const entries = await localGitMutationNodeAdapter.readdir(path)
        if (cleanupTarget.quarantinePath !== undefined && path === join(cleanupTarget.quarantinePath, 'payload')
          && !removalFailed) {
          removalFailed = true
          await localGitMutationNodeAdapter.rmdir(join(path, 'hooks'))
          throw removalFailure
        }
        return entries
      },
      async rm(path, options) {
        if (cleanupTarget.replayArmed) {
          cleanupTarget.replayRemovals.push({
            path,
            recursive: options.recursive === true,
            force: options.force,
          })
        }
        await localGitMutationNodeAdapter.rm(path, options)
      },
      async unlink(path) {
        if (cleanupTarget.replayArmed) cleanupTarget.replayUnlinks.push(path)
        await localGitMutationNodeAdapter.unlink(path)
      },
      async rmdir(path) {
        if (cleanupTarget.replayArmed) cleanupTarget.replayRmdirs.push(path)
        await localGitMutationNodeAdapter.rmdir(path)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution,
      root,
      signal,
      'a',
      24,
      'scratch quarantine retry candidate\n',
      'retry quarantined scratch cleanup\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const scratchPath = durable.effectPlan.scratch.path
    cleanupTarget.scratchPath = scratchPath
    const ownedDirectory = await stat(scratchPath, { bigint: true })
    const indexPath = join(root, '.git', 'index')
    const lockPath = `${indexPath}.lock`
    const originalIndex = await readFile(indexPath)
    const originalIndexInfo = await stat(indexPath, { bigint: true })
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const originalCachedDiff = await gitText(root, 'diff', '--cached', '--name-only')
    const originalWorktreeDiff = await gitText(root, 'diff', '--name-only')

    const canceled = await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )
    expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

    expect(removalFailed).toBe(true)
    expect(restoreFailed).toBe(true)
    const quarantinePath = cleanupTarget.quarantinePath
    if (quarantinePath === undefined) throw new Error('test retained no scratch quarantine path')
    const witnessPath = `${quarantinePath}.owner`
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const retained = await stat(quarantinePath, { bigint: true })
    expect({ device: retained.dev, inode: retained.ino }).toEqual({
      device: ownedDirectory.dev,
      inode: ownedDirectory.ino,
    })
    await expect(stat(join(quarantinePath, 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(witnessPath)).resolves.toBeDefined()
    await expect(stat(join(quarantinePath, 'payload', 'hooks'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(quarantinePath, 'payload', 'objects'))).resolves.toBeDefined()
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    expect(await stat(indexPath, { bigint: true })).toMatchObject({
      dev: originalIndexInfo.dev,
      ino: originalIndexInfo.ino,
      mode: originalIndexInfo.mode,
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe(originalCachedDiff)
    expect(await gitText(root, 'diff', '--name-only')).toBe(originalWorktreeDiff)

    cleanupTarget.replayArmed = true
    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      signal,
    )).toEqual(canceled)
    expect(cleanupTarget.replayRemovals).toEqual([
      { path: witnessPath, recursive: false, force: false },
    ])
    expect(cleanupTarget.replayUnlinks).toEqual(expect.arrayContaining([
      join(quarantinePath, 'payload', 'objects', 'info', 'alternates'),
      join(quarantinePath, 'payload', 'commit.index'),
    ]))
    expect(cleanupTarget.replayRmdirs).toEqual(expect.arrayContaining([
      join(quarantinePath, 'payload', 'objects', 'info'),
      join(quarantinePath, 'payload', 'objects'),
      join(quarantinePath, 'payload'),
      quarantinePath,
    ]))
    expect(cleanupTarget.replayRenames).toEqual([])
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    expect(await stat(indexPath, { bigint: true })).toMatchObject({
      dev: originalIndexInfo.dev,
      ino: originalIndexInfo.ino,
      mode: originalIndexInfo.mode,
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe(originalCachedDiff)
    expect(await gitText(root, 'diff', '--name-only')).toBe(originalWorktreeDiff)
  }, 75_000)

  it.each([
    { name: 'outer quarantine rename', phase: 'outer-rename' },
    { name: 'owner witness rename', phase: 'marker-rename' },
    { name: 'payload removal', phase: 'payload-remove' },
    { name: 'empty wrapper removal', phase: 'wrapper-remove' },
  ] as const)('proves scratch cleanup after $name acknowledgement loss', async ({ phase }) => {
    const root = await repository()
    const state: {
      scratchPath?: string
      quarantinePath?: string
      injected: boolean
      payloadRemovals: number
      payloadMissingProofs: number
    } = {
      injected: false,
      payloadRemovals: 0,
      payloadMissingProofs: 0,
    }
    const failure = new Error(`injected ${phase} acknowledgement loss`)
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async rename(from, to) {
        if (state.scratchPath !== undefined && from === state.scratchPath
          && to.startsWith(`${state.scratchPath}.cleanup-`)) {
          state.quarantinePath = to
          roots.push(to, `${to}.owner`)
          await localGitMutationNodeAdapter.rename(from, to)
          if (phase === 'outer-rename' && !state.injected) {
            state.injected = true
            throw failure
          }
          return
        }
        if (state.quarantinePath !== undefined && from === join(state.quarantinePath, 'owner')
          && to === `${state.quarantinePath}.owner`) {
          await localGitMutationNodeAdapter.rename(from, to)
          if (phase === 'marker-rename' && !state.injected) {
            state.injected = true
            throw failure
          }
          return
        }
        await localGitMutationNodeAdapter.rename(from, to)
      },
      async lstat(path) {
        if (phase === 'payload-remove' && state.injected && state.quarantinePath !== undefined
          && path === join(state.quarantinePath, 'payload')) {
          state.payloadMissingProofs += 1
        }
        return await localGitMutationNodeAdapter.lstat(path)
      },
      async rm(path, options) {
        await localGitMutationNodeAdapter.rm(path, options)
      },
      async rmdir(path) {
        await localGitMutationNodeAdapter.rmdir(path)
        if (phase === 'payload-remove' && path === join(state.quarantinePath ?? '', 'payload')
          && !state.injected) {
          state.payloadRemovals += 1
          state.injected = true
          throw failure
        }
        if (phase === 'wrapper-remove' && path === state.quarantinePath && !state.injected) {
          state.injected = true
          throw failure
        }
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'a', 25)
    if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    const scratchPath = durable.effectPlan.scratch.path
    state.scratchPath = scratchPath
    const pinPath = durable.effectPlan.pin.path
    const indexPath = join(root, '.git', 'index')
    const lockPath = `${indexPath}.lock`
    const originalIndex = await readFile(indexPath)
    const originalIndexInfo = await stat(indexPath, { bigint: true })
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const originalCachedDiff = await gitText(root, 'diff', '--cached', '--name-only')
    const originalWorktreeDiff = await gitText(root, 'diff', '--name-only')
    const frozenWorld: FrozenGitMutationWorld = {
      root,
      pinPath,
      indexPath,
      lockPath,
      indexBytes: originalIndex,
      indexIdentity: {
        device: originalIndexInfo.dev.toString(),
        inode: originalIndexInfo.ino.toString(),
        mode: originalIndexInfo.mode.toString(),
      },
      parent,
      cachedDiff: originalCachedDiff,
      worktreeDiff: originalWorktreeDiff,
    }

    const canceled = await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )
    expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

    expect(state.injected).toBe(true)
    if (state.quarantinePath === undefined) throw new Error('test retained no scratch quarantine path')
    const quarantinePath = `${scratchPath}.cleanup-${durable.effectPlan.scratch.markerDigest.slice(0, 32)}`
    expect(state.quarantinePath).toBe(quarantinePath)
    const witnessPath = `${quarantinePath}.owner`
    expect({
      payloadRemovals: state.payloadRemovals,
      payloadMissingProofs: state.payloadMissingProofs,
    }).toEqual(phase === 'payload-remove'
      ? { payloadRemovals: 1, payloadMissingProofs: 1 }
      : { payloadRemovals: 0, payloadMissingProofs: 0 })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expectFrozenGitMutationWorld(frozenWorld)
    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      signal,
    )).toEqual(canceled)
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expectFrozenGitMutationWorld(frozenWorld)
  }, 75_000)

  it('retries terminal scratch cleanup from a witness-only state', async () => {
    const root = await repository()
    const state: {
      scratchPath?: string
      quarantinePath?: string
      removalFailed: boolean
      replayArmed: boolean
      replayRemovals: Array<{ readonly path: string; readonly recursive: boolean; readonly force: boolean | undefined }>
      replayRmdirs: string[]
      replayRenames: Array<{ readonly from: string; readonly to: string }>
    } = {
      removalFailed: false,
      replayArmed: false,
      replayRemovals: [],
      replayRmdirs: [],
      replayRenames: [],
    }
    const failure = new Error('injected external scratch witness removal failure')
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async rename(from, to) {
        if (state.scratchPath !== undefined && from === state.scratchPath
          && to.startsWith(`${state.scratchPath}.cleanup-`)) {
          state.quarantinePath = to
          roots.push(to, `${to}.owner`)
        }
        if (state.replayArmed) state.replayRenames.push({ from, to })
        await localGitMutationNodeAdapter.rename(from, to)
      },
      async rm(path, options) {
        if (state.quarantinePath !== undefined && path === `${state.quarantinePath}.owner`
          && options.recursive !== true && !state.removalFailed) {
          state.removalFailed = true
          throw failure
        }
        if (state.replayArmed) {
          state.replayRemovals.push({
            path,
            recursive: options.recursive === true,
            force: options.force,
          })
        }
        await localGitMutationNodeAdapter.rm(path, options)
      },
      async rmdir(path) {
        if (state.replayArmed) state.replayRmdirs.push(path)
        await localGitMutationNodeAdapter.rmdir(path)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'b', 26)
    if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    const scratch = durable.effectPlan.scratch
    state.scratchPath = scratch.path
    const indexPath = join(root, '.git', 'index')
    const lockPath = `${indexPath}.lock`
    const originalIndex = await readFile(indexPath)
    const originalIndexInfo = await stat(indexPath, { bigint: true })
    const parent = await gitText(root, 'rev-parse', 'HEAD')

    const canceled = await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )
    expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

    expect(state.removalFailed).toBe(true)
    if (state.quarantinePath === undefined) throw new Error('test retained no scratch quarantine path')
    const witnessPath = `${state.quarantinePath}.owner`
    await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(state.quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    const witness = await stat(witnessPath, { bigint: true })
    expect({ device: witness.dev.toString(), inode: witness.ino.toString() }).toEqual(scratch.ownerIdentity)
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    expect(await stat(indexPath, { bigint: true })).toMatchObject({
      dev: originalIndexInfo.dev,
      ino: originalIndexInfo.ino,
      mode: originalIndexInfo.mode,
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(await gitText(root, 'diff', '--name-only')).toBe('tracked.txt')

    state.replayArmed = true
    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      signal,
    )).toEqual(canceled)
    expect(state.replayRemovals).toEqual([{
      path: witnessPath,
      recursive: false,
      force: false,
    }])
    expect(state.replayRmdirs).toEqual([])
    expect(state.replayRenames).toEqual([])
    await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(state.quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    expect(await stat(indexPath, { bigint: true })).toMatchObject({
      dev: originalIndexInfo.dev,
      ino: originalIndexInfo.ino,
      mode: originalIndexInfo.mode,
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(await gitText(root, 'diff', '--name-only')).toBe('tracked.txt')
  }, 75_000)

  it('preserves a foreign deterministic quarantine collision until terminal replay can retry', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'c', 27)
    if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    const scratch = durable.effectPlan.scratch
    const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
    const witnessPath = `${quarantinePath}.owner`
    const sentinelPath = join(quarantinePath, 'foreign-sentinel')
    const sentinel = Buffer.from('foreign deterministic quarantine collision\n')
    roots.push(quarantinePath, witnessPath)
    await mkdir(quarantinePath, { mode: 0o700 })
    await writeFile(sentinelPath, sentinel, { flag: 'wx', mode: 0o600 })

    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

    await expect(stat(scratch.path)).resolves.toBeDefined()
    await expect(readFile(sentinelPath)).resolves.toEqual(sentinel)
    await rm(quarantinePath, { recursive: true, force: false })

    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
    await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it('fails a durable Commit whose schema-valid candidate id conflicts with its artifacts', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution, root, signal, 'b', 22, 'conflicting candidate\n', 'reject candidate conflict\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const conflicting = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        result: {
          ...durable.effectPlan.result,
          commitId: differentHex(durable.effectPlan.result.commitId),
        },
      },
    })
    await operationPersistence(execution).original(conflicting)

    const resumed = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(resumed).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it('keeps a durable Commit retryable when resumed candidate construction is unavailable', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution, root, signal, 'c', 23, 'retry resumed candidate\n', 'retry resumed commit-tree\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const indexPath = join(root, '.git', 'index')
    const lockPath = join(root, '.git', 'index.lock')
    const originalIndex = await readFile(indexPath)
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const pinBytes = await readFile(pinPath)
    const runner = mutationRunner(execution)
    let rejectedCommitTree = false
    runner.replace(async (...args) => {
      const [, command, , environment] = args
      if (!rejectedCommitTree && command[0] === 'commit-tree'
        && environment.objectDirectory === undefined) {
        rejectedCommitTree = true
        const lock = await stat(lockPath, { bigint: true })
        expect({ device: lock.dev.toString(), inode: lock.ino.toString() }).toEqual(
          durable.effectPlan?.kind === 'commit' ? durable.effectPlan.pin.identity : undefined,
        )
        await expect(readFile(lockPath)).resolves.toEqual(pinBytes)
        throw new GitCommandError('spawn-failure')
      }
      return await runner.original(...args)
    })

    const first = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    runner.restore()

    expect(rejectedCommitTree).toBe(true)
    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      snapshot: { state: 'publishing', revision: durable.snapshot.revision },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 90_000)

  it('recovers a durable Commit after attempting persistence is interrupted', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution, root, signal, 'd', 24, 'interrupted persistence candidate\n', 'retry attempting persist\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const indexPath = join(root, '.git', 'index')
    const lockPath = join(root, '.git', 'index.lock')
    const originalIndex = await readFile(indexPath)
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const sentinel = new Error('interrupted resumed attempting persistence')
    const persistence = operationPersistence(execution)
    let interrupted = false
    persistence.replace(async (record) => {
      if (!interrupted && record.snapshot.state === 'publishing'
        && record.effectPlan?.kind === 'commit'
        && record.effectPlan.publication === 'attempting') {
        interrupted = true
        const lock = await stat(lockPath, { bigint: true })
        expect({ device: lock.dev.toString(), inode: lock.ino.toString() }).toEqual(
          durable.effectPlan?.kind === 'commit' ? durable.effectPlan.pin.identity : undefined,
        )
        await expect(readFile(lockPath)).resolves.toEqual(await readFile(pinPath))
        throw sentinel
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toBe(sentinel)
    persistence.restore()

    expect(interrupted).toBe(true)
    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      signal,
    )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 90_000)

  it.each([
    {
      name: 'fails without effect when a durable not-started Stage finds a directory at the shared index path',
      publication: 'not-started',
      artifact: 'directory',
    },
    {
      name: 'requires reconciliation when an attempted Stage finds an oversized shared index',
      publication: 'attempting',
      artifact: 'oversized-file',
    },
  ] as const)('shared index recovery: $name', async ({ publication, artifact }) => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '8', 13)
    const originalHead = await gitText(root, 'rev-parse', 'HEAD')
    const persistence = operationPersistence(execution)
    const crash = new Error(`simulated process loss after ${publication} Stage evidence`)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
        && record.effectPlan.publication === publication) {
        durable = record
        throw crash
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toBe(crash)
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    expect(durable.snapshot.state).toBe('publishing')
    expect(durable.effectPlan.publication).toBe(publication)
    roots.push(durable.effectPlan.scratch.path)
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const configuredIndexPath = join(root, '.git', 'index')
    const trustedIndexPath = join(
      durable.request.expected.binding.expectedInspection.trusted.canonicalGitDirectory,
      'index',
    )
    const indexPath = join(dirname(pinPath), 'index')
    expect(indexPath).toBe(trustedIndexPath)
    const configuredIndex = await stat(configuredIndexPath, { bigint: true })
    const boundIndex = await stat(indexPath, { bigint: true })
    expect({ device: configuredIndex.dev.toString(), inode: configuredIndex.ino.toString() }).toEqual({
      device: boundIndex.dev.toString(),
      inode: boundIndex.ino.toString(),
    })
    const lockPath = `${indexPath}.lock`
    const backupPath = `${indexPath}.shared-index-recovery-backup`
    const originalIndex = await readFile(indexPath)
    const originalIndexDigest = createHash('sha256').update(originalIndex).digest('hex')
    expect(durable.effectPlan.expectedIndexFile).toMatchObject({
      kind: 'file',
      digest: originalIndexDigest,
      byteLength: originalIndex.byteLength,
    })
    expect(durable.effectPlan.targetIndexFile).not.toMatchObject({ digest: originalIndexDigest })
    if (publication === 'attempting') {
      await link(pinPath, lockPath)
      const pin = await stat(pinPath, { bigint: true })
      const lock = await stat(lockPath, { bigint: true })
      expect({ device: lock.dev.toString(), inode: lock.ino.toString() }).toEqual({
        device: pin.dev.toString(),
        inode: pin.ino.toString(),
      })
    } else {
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }

    await rename(indexPath, backupPath)
    let oversized: Buffer | undefined
    if (artifact === 'directory') {
      await mkdir(indexPath)
    } else {
      oversized = Buffer.alloc(CONFIG.operationMaxIndexBytes + 1, 0x78)
      await writeFile(indexPath, oversized, { flag: 'wx' })
    }
    const artifactBefore = await stat(indexPath, { bigint: true })
    const artifactIdentity = {
      device: artifactBefore.dev.toString(),
      inode: artifactBefore.ino.toString(),
    }
    const artifactDigest = oversized === undefined
      ? undefined
      : createHash('sha256').update(oversized).digest('hex')

    let recovered: unknown
    let recoveryError: unknown
    try {
      recovered = publication === 'not-started'
        ? await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
        : await execution.inspectOperation(prepared.preparation.operation, signal)
    } catch (error) {
      recoveryError = error
    }

    const artifactAfter = await stat(indexPath, { bigint: true })
    expect({ device: artifactAfter.dev.toString(), inode: artifactAfter.ino.toString() }).toEqual(artifactIdentity)
    expect(artifact === 'directory' ? artifactAfter.isDirectory() : artifactAfter.isFile()).toBe(true)
    if (artifactDigest !== undefined) {
      expect(createHash('sha256').update(await readFile(indexPath)).digest('hex')).toBe(artifactDigest)
      expect(artifactAfter.size).toBe(BigInt(CONFIG.operationMaxIndexBytes + 1))
    }
    await expect(readFile(backupPath)).resolves.toEqual(originalIndex)
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(originalHead)
    if (recoveryError !== undefined) throw recoveryError

    expect(recovered).toMatchObject(publication === 'not-started'
      ? {
        ok: true,
        snapshot: {
          state: 'failed',
          failure: { reason: 'unsupported-state' },
          effect: 'none',
        },
      }
      : { state: 'reconciliation-required', reason: 'evidence-conflict' })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 80_000)

  it('requires reconciliation when an attempted publication returns to expected evidence without its witness', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '8', 13)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        durable = record
        throw new Error('simulated process loss after attempting evidence')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated process loss')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no attempted index plan')
    const lockPath = join(root, '.git', 'index.lock')
    await link(durable.effectPlan.pin.path, lockPath)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'reconciliation-required',
      reason: 'evidence-conflict',
    })
    expect(liveOperationCount(execution)).toBe(0)
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 45_000)

  it('rejects a Commit with no staged change before publication', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    await writeFile(join(root, 'tracked.txt'), 'worktree-only Commit candidate\n')
    const inspected = await execution.inspectProject({ binding }, signal)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') {
      throw new Error(`test repository was not inspectable: ${JSON.stringify(inspected)}`)
    }
    const request: CommitHostOperationRequest = {
      type: 'commit',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '5'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      message: 'reject a worktree-only Commit\n',
    }
    const prepared = await execution.prepareOperation(request, acceptedAdmission(26), signal)
    if (!prepared.ok) throw new Error(`test Commit was not prepared: ${prepared.reason}`)

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('rejects a Commit when its private write-tree result drifts', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, inspected } = await preparedCommit(
      execution,
      root,
      signal,
      '5',
      26,
      'tree drift candidate\n',
      'reject a mismatched private tree\n',
    )
    if (inspected.observation.index.kind !== 'tree') throw new Error('test retained no expected tree')
    const expectedTreeId = inspected.observation.index.treeId
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const originalGitEntries = (await readdir(join(root, '.git'))).sort()
    const runner = mutationRunner(execution)
    let injected = false
    let scratchPath: string | undefined
    runner.replace(async (...args) => {
      const result = await runner.original(...args)
      const [, command, , environment] = args
      if (!injected && command[0] === 'write-tree') {
        if (environment.indexFile === undefined) throw new Error('test write-tree used no private index')
        scratchPath = dirname(dirname(environment.indexFile))
        roots.push(scratchPath)
        injected = true
        return {
          ...result,
          stdout: Buffer.from(`${differentHex(expectedTreeId)}\n`, 'ascii'),
        }
      }
      return result
    })

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    runner.restore()

    expect(injected).toBe(true)
    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'observation-stale' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(scratchPath).toBeDefined()
    await expect(stat(scratchPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(join(root, '.git'))).sort()).toEqual(originalGitEntries)
  }, 75_000)

  it.each([
    'scratch',
    'pin',
    'lock',
  ] as const)('preserves a foreign %s Commit artifact before its initial publication', async (artifact) => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const lockPath = `${indexPath}.lock`
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const state = {
      armed: false,
      replaced: false,
      publishCalls: 0,
      pinReadsAfterLink: 0,
      linkedPinPath: undefined as string | undefined,
      foreignPath: undefined as string | undefined,
      retainedOriginalPath: undefined as string | undefined,
      foreignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      recursiveRemovals: [] as string[],
    }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async link(from, to) {
        await localGitMutationNodeAdapter.link(from, to)
        if (artifact === 'lock' && state.armed && to === lockPath) state.linkedPinPath = from
      },
      async open(path, flags, mode) {
        if (artifact === 'lock' && state.linkedPinPath !== undefined
          && path === state.linkedPinPath && flags === 'r') {
          state.pinReadsAfterLink += 1
          if (!state.replaced && state.pinReadsAfterLink === 2) {
            await replaceFileWithSameContents(state, lockPath)
          }
        }
        return await localGitMutationNodeAdapter.open(path, flags, mode)
      },
      async rename(from, to) {
        if (from === lockPath && to === indexPath) state.publishCalls += 1
        await localGitMutationNodeAdapter.rename(from, to)
      },
      async rm(path, options) {
        if (options.recursive === true) state.recursiveRemovals.push(path)
        await localGitMutationNodeAdapter.rm(path, options)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      '5',
      26,
      `foreign ${artifact} candidate\n`,
      `preserve foreign ${artifact}\n`,
    )
    const originalIndex = await readFile(indexPath)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
        && record.effectPlan.publication === 'not-started') {
        durable = record
        roots.push(record.effectPlan.scratch.path)
        if (artifact === 'scratch') {
          await replaceFileWithSameContents(state, join(record.effectPlan.scratch.path, 'owner'))
        } else if (artifact === 'pin') {
          await replaceFileWithSameContents(state, record.effectPlan.pin.path)
        } else {
          state.armed = true
        }
      }
    })
    const runner = mutationRunner(execution)
    let updateRefCalls = 0
    runner.replace(async (...args) => {
      const [, command] = args
      if (command[0] === 'update-ref') updateRefCalls += 1
      return await runner.original(...args)
    })

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    runner.restore()
    persistence.restore()

    if (durable?.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const foreignPath = state.foreignPath
    const retainedOriginalPath = state.retainedOriginalPath
    if (foreignPath === undefined || retainedOriginalPath === undefined) {
      throw new Error('test did not replace the selected Commit artifact')
    }
    expect(state.replaced).toBe(true)
    expect(state.publishCalls).toBe(0)
    expect(state.foreignIdentity).not.toEqual(
      artifact === 'scratch' ? durable.effectPlan.scratch.ownerIdentity : durable.effectPlan.pin.identity,
    )
    expect(state.recursiveRemovals).toEqual([])
    expect(updateRefCalls).toBe(0)
    expect(started).toMatchObject({
      ok: false,
      reason: artifact === 'lock' ? 'busy' : 'unavailable',
      snapshot: { state: 'publishing', revision: durable.snapshot.revision },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(foreignPath)).resolves.toBeDefined()
    await expect(stat(retainedOriginalPath)).resolves.toBeDefined()
    await expect(stat(durable.effectPlan.pin.path)).resolves.toBeDefined()
    await expect(stat(durable.effectPlan.scratch.path)).resolves.toBeDefined()
    if (artifact === 'lock') expect(state.pinReadsAfterLink).toBe(2)
    else await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)

  it('recovers a Commit when update-ref returns non-empty stdout after applying', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      '5',
      26,
      'non-empty update-ref output candidate\n',
      'recover applied update-ref output anomaly\n',
    )
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.effectPlan?.kind === 'commit') durable = record
      await persistence.original(record)
    })
    const runner = mutationRunner(execution)
    let updateRefCalls = 0
    runner.replace(async (...args) => {
      const result = await runner.original(...args)
      const [, command] = args
      if (command[0] === 'update-ref') {
        updateRefCalls += 1
        return { ...result, stdout: Buffer.from('unexpected update-ref output\n', 'utf8') }
      }
      return result
    })

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    runner.restore()
    persistence.restore()

    if (durable?.effectPlan?.kind !== 'commit') throw new Error('test retained no Commit plan')
    expect(updateRefCalls).toBe(1)
    expect(started).toMatchObject({
      ok: true,
      snapshot: { state: 'succeeded', result: { type: 'commit' } },
    })
    if (!started.ok || started.snapshot.state !== 'succeeded'
      || started.snapshot.result.type !== 'commit') return
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(started.snapshot.result.commitId)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 90_000)

  it('rejects a Commit when only the worktree drifts after preparation', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'c',
      23,
      'staged commit content\n',
      'worktree precondition\n',
    )
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const stagedTree = await gitText(root, 'write-tree')
    await writeFile(join(root, 'tracked.txt'), 'worktree-only drift\n')

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: { state: 'failed', failure: { reason: 'observation-stale' }, effect: 'none' },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'write-tree')).toBe(stagedTree)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 45_000)

  it('publishes one deterministic hook-free Commit through update-ref CAS', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'committed\n')
    await git(root, 'add', '--', 'tracked.txt')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') return
    const request: CommitHostOperationRequest = {
      type: 'commit',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '9'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      message: 'deterministic subject\n\nexact body\n',
    }
    const admission: HostOperationAdmissionSource = () => Promise.resolve({
      kind: 'accepted',
      admissionRevision: 14,
    })
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const persistence = operationPersistence(execution)
    let succeededRecord: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'succeeded') succeededRecord = record
    })

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    persistence.restore()

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'commit',
          parent: { kind: 'commit', objectId: parent },
          target: { kind: 'symbolic-ref', ref: 'refs/heads/main' },
          author: { name: 'Saki Test', email: 'saki@example.invalid', source: 'git-config' },
          committer: { name: 'Saki Test', email: 'saki@example.invalid', source: 'git-config' },
        },
      },
    })
    if (!started.ok || started.snapshot.state !== 'succeeded'
      || started.snapshot.result.type !== 'commit') return
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(started.snapshot.result.commitId)
    expect(await gitText(root, 'show', '-s', '--format=%B', 'HEAD')).toBe('deterministic subject\n\nexact body')
    expect(await gitText(root, 'status', '--porcelain=v1')).toBe('')
    expect(started.snapshot.result.treeId).toBe(inspected.observation.index.treeId)
    if (succeededRecord?.effectPlan?.kind !== 'commit') throw new Error('test retained no Commit plan')
    const operationSchema = sakiHostExecutionDomainSpec.tables.operations.valueSchema
    const parsedSucceededRecord = operationSchema.safeParse(succeededRecord)
    expect(
      parsedSucceededRecord.success,
      parsedSucceededRecord.success ? undefined : JSON.stringify(parsedSucceededRecord.error.issues),
    ).toBe(true)
    expect(succeededRecord.effectPlan).toMatchObject({
      indexReadLimit: CONFIG.operationMaxIndexBytes,
      reflogReadLimit: CONFIG.operationMaxReflogBytes,
    })
    const { indexReadLimit: _commitIndexReadLimit, ...commitPlanWithoutIndexReadLimit }
      = succeededRecord.effectPlan
    expect(operationSchema.safeParse({
      ...succeededRecord,
      effectPlan: commitPlanWithoutIndexReadLimit,
    }).success).toBe(false)
    const { reflogReadLimit: _commitReflogReadLimit, ...commitPlanWithoutReflogReadLimit }
      = succeededRecord.effectPlan
    expect(operationSchema.safeParse({
      ...succeededRecord,
      effectPlan: commitPlanWithoutReflogReadLimit,
    }).success).toBe(false)
    for (const reflogReadLimit of [0, bufferConstants.MAX_LENGTH + 1]) {
      expect(operationSchema.safeParse({
        ...succeededRecord,
        effectPlan: { ...succeededRecord.effectPlan, reflogReadLimit },
      }).success).toBe(false)
    }
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        indexReadLimit: succeededRecord.effectPlan.pin.byteLength - 1,
      },
    }, 'Commit effect plan index read limit cannot retain its pin')
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: { ...succeededRecord.effectPlan, targetRef: 'refs/heads/other' },
    }, 'attached Commit effect plan disagrees with expected HEAD')
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        result: { ...succeededRecord.effectPlan.result, commitId: '0'.repeat(40) },
      },
    }, 'Host Operation success disagrees with published effect plan')
    const wrongObjectWidth = 64
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        result: {
          ...succeededRecord.effectPlan.result,
          commitId: 'a'.repeat(wrongObjectWidth),
        },
      },
    }, 'Commit effect plan uses a different object format')
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        result: {
          ...succeededRecord.effectPlan.result,
          treeId: differentHex(succeededRecord.effectPlan.result.treeId),
        },
      },
    }, 'Commit effect plan tree disagrees with the expected index')
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        result: {
          ...succeededRecord.effectPlan.result,
          committer: { ...succeededRecord.effectPlan.result.committer, name: 'Another Committer' },
        },
      },
    }, 'Commit effect plan uses asymmetric author and committer evidence')
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: { ...succeededRecord.effectPlan, reflogMarker: 'unexpected reflog marker' },
    }, 'Commit effect plan uses an unexpected reflog marker')
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        scratch: {
          ...succeededRecord.effectPlan.scratch,
          markerDigest: differentHex(succeededRecord.effectPlan.scratch.markerDigest),
        },
      },
    }, 'effect plan scratch marker disagrees with operation identity')
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        pin: { ...succeededRecord.effectPlan.pin, digest: differentHex(succeededRecord.effectPlan.pin.digest) },
      },
    }, 'Commit index pin disagrees with operation identity')
    if (succeededRecord.request.type !== 'commit'
      || succeededRecord.request.expected.head.kind !== 'commit'
      || succeededRecord.snapshot.state !== 'succeeded'
      || succeededRecord.snapshot.result.type !== 'commit') {
      throw new Error('test retained no attached succeeded Commit')
    }
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        expectedOldObjectId: differentHex(succeededRecord.effectPlan.expectedOldObjectId),
      },
    }, 'Commit effect plan parent disagrees with expected HEAD')
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        result: {
          ...succeededRecord.effectPlan.result,
          commitId: succeededRecord.effectPlan.expectedOldObjectId,
        },
      },
    }, 'Commit effect plan has no observable publication')
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        result: { ...succeededRecord.effectPlan.result, parent: { kind: 'none' } },
      },
    }, 'Commit effect plan parent disagrees with expected HEAD')
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        result: {
          ...succeededRecord.effectPlan.result,
          parent: {
            kind: 'commit',
            objectId: differentHex(succeededRecord.request.expected.head.objectId),
          },
        },
      },
    }, 'Commit effect plan parent disagrees with expected HEAD')
    const selectedChange = inspected.observation.changes[0]
    if (selectedChange === undefined) throw new Error('test retained no Commit source change')
    const { message: _message, ...requestBase } = succeededRecord.request
    const crossKindRequest: StageFilesHostOperationRequest = {
      ...requestBase,
      type: 'stage-files',
      changes: [{ id: selectedChange.id, fingerprint: selectedChange.fingerprint }],
    }
    const crossKindFingerprint = localHostOperationRequestFingerprint(crossKindRequest)
    const crossKindCore = hostOperationSnapshotCore(succeededRecord.snapshot)
    expectOperationRecordIssue({
      ...succeededRecord,
      request: crossKindRequest,
      snapshot: {
        ...crossKindCore,
        operation: { ...crossKindCore.operation, type: 'stage-files' },
        requestFingerprint: crossKindFingerprint,
        state: 'publishing',
        plannedAt: crossKindCore.updatedAt,
        effectPlannedAt: crossKindCore.updatedAt,
        publishingAt: crossKindCore.updatedAt,
      },
    }, 'Commit effect plan disagrees with Host Operation type')
    const longRef = `refs/heads/${'a/'.repeat(600)}branch`
    expect(longRef.length).toBeGreaterThan(1_024)
    expect(longRef.length).toBeLessThanOrEqual(MAX_GIT_REF_CHARS)
    const longRequest = {
      ...succeededRecord.request,
      expected: {
        ...succeededRecord.request.expected,
        head: { ...succeededRecord.request.expected.head, symbolicRef: longRef },
      },
    }
    const requestFingerprint = localHostOperationRequestFingerprint(longRequest)
    const result = {
      ...succeededRecord.effectPlan.result,
      target: { kind: 'symbolic-ref' as const, ref: longRef },
    }
    const operationId = succeededRecord.snapshot.operation.id
    const marker = (kind: 'scratch' | 'index-lock'): Buffer => Buffer.from(
      `saki-host-operation-${kind}/v1\0${operationId}\0${requestFingerprint.digest}\0`,
      'utf8',
    )
    const scratchMarker = marker('scratch')
    const indexMarker = marker('index-lock')
    expect(operationSchema.safeParse({
      ...succeededRecord,
      request: longRequest,
      snapshot: { ...succeededRecord.snapshot, requestFingerprint, result },
      effectPlan: {
        ...succeededRecord.effectPlan,
        targetRef: longRef,
        result,
        scratch: {
          ...succeededRecord.effectPlan.scratch,
          markerDigest: createHash('sha256').update(scratchMarker).digest('hex'),
        },
        pin: {
          ...succeededRecord.effectPlan.pin,
          digest: createHash('sha256').update(indexMarker).digest('hex'),
          byteLength: indexMarker.byteLength,
        },
      },
    }).success).toBe(true)
  }, 45_000)

  it('records the canonical Git identity that the Commit object actually contains', async () => {
    const root = await repository()
    await git(root, 'config', 'user.name', ' Alice ')
    await git(root, 'config', 'user.email', ' saki@example.invalid ')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      '4',
      88,
      'canonical identity contents\n',
      'canonical Git identity\n',
    )

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'commit',
          author: { name: 'Alice', email: 'saki@example.invalid', source: 'git-config' },
          committer: { name: 'Alice', email: 'saki@example.invalid', source: 'git-config' },
        },
      },
    })
    if (!started.ok || started.snapshot.state !== 'succeeded'
      || started.snapshot.result.type !== 'commit') return
    const signature = started.snapshot.result.author
    const object = await gitText(root, 'cat-file', '-p', started.snapshot.result.commitId)
    expect(object.split('\n')).toEqual(expect.arrayContaining([
      `author ${signature.name} <${signature.email}> ${signature.timestamp} ${signature.timezone}`,
      `committer ${signature.name} <${signature.email}> ${signature.timestamp} ${signature.timezone}`,
    ]))
  }, 60_000)

  it('preserves an unexpected canonical Git identity command failure', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'f',
      98,
      'unexpected canonical identity failure\n',
      'Unexpected canonical identity failure',
    )
    const failure = new Error('injected canonical Git identity failure')
    const runner = mutationRunner(execution)
    runner.replace(async (...args) => {
      if (args[1][0] === 'var' && args[1][1] === 'GIT_AUTHOR_IDENT') throw failure
      return await runner.original(...args)
    })

    try {
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).rejects.toBe(failure)
    } finally {
      runner.restore()
    }

    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      signal,
    )).toMatchObject({ state: 'planning' })
  }, 60_000)

  it.each([
    ['name', '5', ',:;', 'saki@example.invalid'],
    ['email', '6', 'Saki Test', ',:;'],
  ] as const)('rejects a Commit whose Git-canonical $s is empty before persisting a plan', async (
    _field,
    payloadDigit,
    name,
    email,
  ) => {
    const root = await repository()
    await git(root, 'config', 'user.name', name)
    await git(root, 'config', 'user.email', email)
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      payloadDigit,
      89,
      'invalid canonical identity contents\n',
      'invalid canonical identity\n',
    )
    const persistence = operationPersistence(execution)
    let publishingRecords = 0
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing') publishingRecords += 1
      await persistence.original(record)
    })

    try {
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: true,
        snapshot: {
          state: 'failed',
          failure: { reason: 'unsupported-state' },
          effect: 'none',
        },
      })
    } finally {
      persistence.restore()
    }
    expect(publishingRecords).toBe(0)
  }, 60_000)

  it('publishes a deterministic Commit in a SHA-256 repository', async () => {
    const root = await repository('sha256')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      '9',
      14,
      'sha256 committed contents\n',
      'sha256 deterministic commit\n',
    )

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: { state: 'succeeded', result: { type: 'commit' } },
    })
    if (!started.ok || started.snapshot.state !== 'succeeded'
      || started.snapshot.result.type !== 'commit') return
    expect(started.snapshot.result.commitId).toHaveLength(64)
    expect(started.snapshot.result.treeId).toHaveLength(64)
  }, 45_000)

  it('creates the frozen attached branch for an unborn Commit', async () => {
    const root = await unbornRepository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, inspected } = await preparedCommit(
      execution,
      root,
      signal,
      'a',
      15,
      'first tracked contents\n',
      'initial structured commit\n',
    )
    const persistence = operationPersistence(execution)
    let succeededRecord: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'succeeded') succeededRecord = record
    })

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    persistence.restore()

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'commit',
          treeId: inspected.observation.index.kind === 'tree'
            ? inspected.observation.index.treeId
            : undefined,
          parent: { kind: 'none' },
          target: { kind: 'symbolic-ref', ref: 'refs/heads/main' },
        },
      },
    })
    if (!started.ok || started.snapshot.state !== 'succeeded'
      || started.snapshot.result.type !== 'commit') return
    expect(await gitText(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(await gitText(root, 'rev-parse', 'refs/heads/main')).toBe(started.snapshot.result.commitId)
    if (succeededRecord?.effectPlan?.kind !== 'commit') throw new Error('test retained no unborn Commit plan')
    expectOperationRecordIssue({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        expectedOldObjectId: '1'.repeat(succeededRecord.effectPlan.expectedOldObjectId.length),
      },
    }, 'unborn Commit effect plan disagrees with expected HEAD')
  }, 45_000)

  it('removes a Commit scratch when the first effect-plan persistence fails', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'b',
      16,
      'discarded commit contents\n',
      'discarded commit candidate\n',
    )
    const persistence = operationPersistence(execution)
    let scratchPath: string | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started'
        && (record.effectPlan.kind === 'index' || record.effectPlan.kind === 'commit')) {
        scratchPath = record.effectPlan.scratch.path
        throw new Error('simulated first Commit plan persistence failure')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated first Commit plan persistence failure')
    persistence.restore()
    expect(scratchPath).toBeDefined()
    if (scratchPath === undefined) return
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('surfaces a Commit pin cleanup failure when the first effect plan is not durable', async () => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const lockPath = `${indexPath}.lock`
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const persistenceFailure = new Error('injected undurable Commit plan persistence failure')
    const cleanupFailure = Object.assign(new Error('injected undurable Commit pin cleanup failure'), {
      code: 'EACCES',
      errno: -13,
      syscall: 'unlink',
    })
    const state = {
      injectCleanupFailure: true,
      pinRemovals: 0,
      lockLinks: 0,
    }
    let plan: Extract<NonNullable<LocalHostOperationRecord['effectPlan']>, { readonly kind: 'commit' }>
      | undefined
    let pinRemovalOptions: { readonly recursive?: boolean; readonly force: boolean } | undefined
    let quarantinePath: string | undefined
    let witnessPath: string | undefined
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async rm(path, options) {
        if (state.injectCleanupFailure && plan !== undefined && path === plan.pin.path) {
          pinRemovalOptions = { ...options }
          if (!options.force && options.recursive !== true) {
            state.injectCleanupFailure = false
            state.pinRemovals += 1
            throw cleanupFailure
          }
        }
        await localGitMutationNodeAdapter.rm(path, options)
      },
      async link(from, to) {
        if (plan !== undefined && from === plan.pin.path && to === lockPath) state.lockLinks += 1
        await localGitMutationNodeAdapter.link(from, to)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'c',
      17,
      'undurable Commit cleanup candidate\n',
      'undurable Commit cleanup candidate\n',
    )
    const stagedTree = await gitText(root, 'write-tree')
    const originalIndex = await readFile(indexPath)
    const originalIndexInfo = await stat(indexPath, { bigint: true })
    const persistence = operationPersistence(execution)
    const runner = mutationRunner(execution)
    let planPersists = 0
    const updateRefCommands: string[][] = []
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
        && record.effectPlan.publication === 'not-started') {
        planPersists += 1
        plan = record.effectPlan
        quarantinePath = `${record.effectPlan.scratch.path}.cleanup-${record.effectPlan.scratch.markerDigest.slice(0, 32)}`
        witnessPath = `${quarantinePath}.owner`
        for (const path of [record.effectPlan.scratch.path, quarantinePath, witnessPath]) {
          if (!roots.includes(path)) roots.push(path)
        }
        throw persistenceFailure
      }
      await persistence.original(record)
    })
    runner.replace(async (...args) => {
      const [, command] = args
      if (command[0] === 'update-ref') updateRefCommands.push([...command])
      return await runner.original(...args)
    })

    try {
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).rejects.toBe(cleanupFailure)
    } finally {
      persistence.restore()
      runner.restore()
    }

    expect(planPersists).toBe(1)
    if (plan === undefined) throw new Error('test retained no undurable Commit plan')
    expect(state).toEqual({ injectCleanupFailure: false, pinRemovals: 1, lockLinks: 0 })
    expect(pinRemovalOptions).toEqual({ force: false })
    expect(updateRefCommands).toEqual([])
    await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    if (quarantinePath === undefined || witnessPath === undefined) {
      throw new Error('test retained no undurable Commit cleanup paths')
    }
    await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const pinInfo = await stat(plan.pin.path, { bigint: true })
    expect(pinInfo.isFile()).toBe(true)
    expect({ device: pinInfo.dev.toString(), inode: pinInfo.ino.toString() }).toEqual(plan.pin.identity)
    const pinBytes = await readFile(plan.pin.path)
    expect(pinBytes.byteLength).toBe(plan.pin.byteLength)
    expect(createHash('sha256').update(pinBytes).digest('hex')).toBe(plan.pin.digest)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'planning',
      revision: 2,
    })
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    const finalIndexInfo = await stat(indexPath, { bigint: true })
    expect(finalIndexInfo.isFile()).toBe(true)
    expect({
      device: finalIndexInfo.dev.toString(),
      inode: finalIndexInfo.ino.toString(),
      mode: Number(finalIndexInfo.mode & 0o777n),
    }).toEqual({
      device: originalIndexInfo.dev.toString(),
      inode: originalIndexInfo.ino.toString(),
      mode: Number(originalIndexInfo.mode & 0o777n),
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'write-tree')).toBe(stagedTree)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    await expect(run('git', ['cat-file', '-e', plan.result.commitId], {
      cwd: root,
      windowsHide: true,
    })).rejects.toBeDefined()

    await rm(plan.pin.path, { force: false })
    await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await gitText(root, 'rev-parse', 'HEAD')).not.toBe(parent)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
  }, 90_000)

  it('persists a complete Commit pin before creating the blocking index lock', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'b',
      16,
      'pinned commit contents\n',
      'durable pinned commit candidate\n',
    )
    const persistence = operationPersistence(execution)
    let pinPath: string | undefined
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
        && record.effectPlan.publication === 'not-started') {
        durable = record
        const pin = (record.effectPlan as unknown as {
          readonly pin: {
            readonly path: string
            readonly digest: string
            readonly byteLength: number
            readonly identity: { readonly device: string; readonly inode: string }
            readonly mode: number
          }
        }).pin
        pinPath = pin.path
        const bytes = await readFile(pin.path)
        const info = await stat(pin.path, { bigint: true })
        expect(bytes.byteLength).toBe(pin.byteLength)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.digest)
        expect(Number(info.mode & 0o777n)).toBe(pin.mode)
        expect({ device: info.dev.toString(), inode: info.ino.toString() }).toEqual(pin.identity)
        await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
        throw new Error('simulated first Commit plan persistence failure after pin inspection')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated first Commit plan persistence failure after pin inspection')
    persistence.restore()
    expect(pinPath).toBeDefined()
    if (pinPath !== undefined) await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (durable?.effectPlan?.kind !== 'commit') throw new Error('test retained no Commit plan')
    expect(sakiHostExecutionDomainSpec.tables.operations.valueSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        pin: { ...durable.effectPlan.pin, byteLength: durable.effectPlan.pin.byteLength + 1 },
      },
    }).success).toBe(false)
  }, 60_000)

  it('keeps Commit terminal cleanup retryable after a committed persistence acknowledgement loss', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'b',
      16,
      'terminal Commit contents\n',
      'terminal Commit acknowledgement\n',
    )
    const persistence = operationPersistence(execution)
    let pinPath: string | undefined
    let scratchPath: string | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'succeeded' && record.effectPlan?.kind === 'commit') {
        pinPath = record.effectPlan.pin.path
        scratchPath = record.effectPlan.scratch.path
        await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(pinPath)).resolves.toBeDefined()
        await expect(stat(scratchPath)).resolves.toBeDefined()
        await persistence.original(record)
        throw new Error('simulated committed Commit acknowledgement loss')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated committed Commit acknowledgement loss')
    persistence.restore()
    if (pinPath === undefined || scratchPath === undefined) throw new Error('test retained no cleanup resources')
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
      result: { type: 'commit' },
    })
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('does not persist a resumed Commit attempt canceled after its final candidate returns', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const captureSignal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution,
      root,
      captureSignal,
      'c',
      17,
      'canceled resumed publication\n',
      'cancel after the final candidate\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const originalIndex = await readFile(join(root, '.git', 'index'))
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const lockPath = join(root, '.git', 'index.lock')
    const controller = new AbortController()
    const reason = new Error('cancel after resumed Commit candidate')
    const runner = mutationRunner(execution)
    let candidates = 0
    runner.replace(async (...args) => {
      const result = await runner.original(...args)
      const [, command] = args
      if (command[0] === 'commit-tree') {
        candidates += 1
        if (candidates === 2) controller.abort(reason)
      }
      return result
    })
    const persistence = operationPersistence(execution)
    let attemptedPersisted = false
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
        && record.effectPlan.publication === 'attempting') attemptedPersisted = true
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      controller.signal,
    )).rejects.toBe(reason)
    runner.restore()
    persistence.restore()

    expect(candidates).toBe(2)
    expect(attemptedPersisted).toBe(false)
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(join(root, '.git', 'index'))).resolves.toEqual(originalIndex)
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()
    const freshSignal = new AbortController().signal
    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      freshSignal,
    )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      freshSignal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
  }, 90_000)

  it('preserves abort identity when resumed Commit cleanup also finds a corrupt owned lock', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const captureSignal = new AbortController().signal
    const { prepared, durable } = await captureDurableNotStartedCommit(
      execution,
      root,
      captureSignal,
      'c',
      18,
      'abort cleanup candidate\n',
      'preserve abort over cleanup failure\n',
    )
    if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const pinPath = durable.effectPlan.pin.path
    const pinBytes = await readFile(pinPath)
    const lockPath = join(root, '.git', 'index.lock')
    const controller = new AbortController()
    const reason = new Error('cancel with corrupt owned Commit lock')
    const runner = mutationRunner(execution)
    let candidates = 0
    let corrupted = false
    runner.replace(async (...args) => {
      const [, command] = args
      if (command[0] === 'commit-tree') {
        candidates += 1
        if (candidates === 2) {
          const lock = await stat(lockPath, { bigint: true })
          expect({ device: lock.dev.toString(), inode: lock.ino.toString() }).toEqual(
            durable.effectPlan?.kind === 'commit' ? durable.effectPlan.pin.identity : undefined,
          )
          await writeFile(lockPath, Buffer.concat([pinBytes, Buffer.from('corrupt')]))
          corrupted = true
          controller.abort(reason)
          throw new GitCommandError('spawn-failure')
        }
      }
      return await runner.original(...args)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      controller.signal,
    )).rejects.toBe(reason)
    runner.restore()

    expect(candidates).toBe(2)
    expect(corrupted).toBe(true)
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(readFile(lockPath)).resolves.toEqual(Buffer.concat([pinBytes, Buffer.from('corrupt')]))
    await expect(readFile(pinPath)).resolves.toEqual(Buffer.concat([pinBytes, Buffer.from('corrupt')]))
    const freshSignal = new AbortController().signal
    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      freshSignal,
    )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
  }, 90_000)

  it('removes Commit locks when a resumed update-ref attempt fails', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'c',
      17,
      'failed resumed publication\n',
      'failed resumed update-ref\n',
    )
    const originalIndex = await readFile(join(root, '.git', 'index'))
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
        && record.effectPlan.publication === 'not-started') {
        durable = record
      }
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated crash before resumed Commit publication')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash before resumed Commit publication')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    roots.push(durable.effectPlan.scratch.path)
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const lockPath = join(root, '.git', 'index.lock')
    const pinBytes = await readFile(pinPath)
    const runner = mutationRunner(execution)
    let rejectedUpdate = false
    let rejectedRecoveryRead = false
    let lockBeforeUpdate: {
      readonly bytes: Buffer
      readonly identity: { readonly device: string; readonly inode: string }
    } | undefined
    runner.replace(async (...args) => {
      const [, command] = args
      if (command[0] === 'update-ref') {
        const lock = await stat(lockPath, { bigint: true })
        lockBeforeUpdate = {
          bytes: await readFile(lockPath),
          identity: { device: lock.dev.toString(), inode: lock.ino.toString() },
        }
        rejectedUpdate = true
        throw new GitCommandError('nonzero', 1)
      }
      return await runner.original(...args)
    })
    runner.replaceRun(async (...args) => {
      const [, command] = args
      if (rejectedUpdate && !rejectedRecoveryRead && command[0] === 'rev-parse'
        && command[1] === '--verify' && command[2] === '--end-of-options') {
        rejectedRecoveryRead = true
        throw new GitCommandError('spawn-failure')
      }
      return await runner.originalRun(...args)
    })

    const resumed = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    runner.restore()

    expect(rejectedUpdate).toBe(true)
    expect(rejectedRecoveryRead).toBe(true)
    expect(lockBeforeUpdate).toEqual({ bytes: pinBytes, identity: durable.effectPlan.pin.identity })
    expect(resumed).toMatchObject({
      ok: false,
      reason: 'unavailable',
      snapshot: { state: 'publishing' },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(join(root, '.git', 'index'))).resolves.toEqual(originalIndex)
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(pinPath)).resolves.toEqual(pinBytes)
    await expect(stat(scratchPath)).resolves.toBeDefined()

    const reconciled = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(reconciled).toMatchObject({
      ok: true,
      snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(join(root, '.git', 'index'))).resolves.toEqual(originalIndex)
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('releases the initial Commit lock when update-ref and immediate recovery observation fail', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'c', 17, 'initial publication failure\n', 'initial update-ref failure\n',
    )
    const originalIndex = await readFile(join(root, '.git', 'index'))
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit') durable = record
      await persistence.original(record)
    })
    const runner = mutationRunner(execution)
    let rejectedUpdate = false
    let rejectedRecoveryRead = false
    let lockBeforeUpdate: Buffer | undefined
    runner.replace(async (...args) => {
      const [, command] = args
      if (!rejectedUpdate && command[0] === 'update-ref') {
        rejectedUpdate = true
        lockBeforeUpdate = await readFile(join(root, '.git', 'index.lock'))
        throw new GitCommandError('nonzero', 1)
      }
      return await runner.original(...args)
    })
    runner.replaceRun(async (...args) => {
      const [, command] = args
      if (rejectedUpdate && !rejectedRecoveryRead && command[0] === 'rev-parse'
        && command[1] === '--verify' && command[2] === '--end-of-options') {
        rejectedRecoveryRead = true
        throw new GitCommandError('spawn-failure')
      }
      return await runner.originalRun(...args)
    })

    const first = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    runner.restore()
    persistence.restore()

    expect(rejectedUpdate).toBe(true)
    expect(rejectedRecoveryRead).toBe(true)
    if (durable?.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    expect(lockBeforeUpdate).toEqual(await readFile(pinPath))
    expect(first).toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(join(root, '.git', 'index'))).resolves.toEqual(originalIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(join(root, '.git', 'index'))).resolves.toEqual(originalIndex)
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it.each([
    ['transient', new GitCommandError('spawn-failure'), 'retry' as const],
    ['missing target', new GitCommandError('nonzero', 128), 'no-effect' as const],
  ])('classifies %s while reading the target of a durable not-started Commit', async (
    _name,
    failure,
    expected,
  ) => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'd', 18, 'target read classification\n', 'target read recovery\n',
    )
    const originalIndex = await readFile(join(root, '.git', 'index'))
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
        && record.effectPlan.publication === 'not-started') durable = record
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('captured durable Commit before target read')
      }
      await persistence.original(record)
    })
    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('captured durable Commit before target read')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
    const pinPath = durable.effectPlan.pin.path
    const scratchPath = durable.effectPlan.scratch.path
    const runner = mutationRunner(execution)
    let injected = false
    runner.replaceRun(async (...args) => {
      const [, command] = args
      if (!injected && command[0] === 'rev-parse' && command[1] === '--verify'
        && command[2] === '--end-of-options') {
        injected = true
        throw failure
      }
      return await runner.originalRun(...args)
    })

    const result = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    runner.restore()

    expect(injected).toBe(true)
    if (expected === 'retry') {
      expect(result).toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      await expect(readFile(join(root, '.git', 'index'))).resolves.toEqual(originalIndex)
      await expect(stat(pinPath)).resolves.toBeDefined()
      await expect(stat(scratchPath)).resolves.toBeDefined()
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    } else {
      expect(result).toMatchObject({
        ok: true,
        snapshot: {
          state: 'failed',
          failure: { reason: 'observation-stale' },
          effect: 'none',
        },
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    }
    await expect(readFile(join(root, '.git', 'index'))).resolves.toEqual(originalIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it('publishes to the frozen branch when an external checkout races after final validation', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    await git(root, 'branch', 'other')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'b',
      16,
      'race-safe contents\n',
      'frozen target commit\n',
    )
    const runner = mutationRunner(execution)
    let raced = false
    runner.replace(async (...args) => {
      const [, command] = args
      if (!raced && command[0] === 'update-ref') {
        raced = true
        await git(root, 'symbolic-ref', 'HEAD', 'refs/heads/other')
      }
      return await runner.original(...args)
    })

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    runner.restore()

    expect(raced).toBe(true)
    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: { type: 'commit', target: { kind: 'symbolic-ref', ref: 'refs/heads/main' } },
      },
    })
    if (!started.ok || started.snapshot.state !== 'succeeded'
      || started.snapshot.result.type !== 'commit') return
    expect(await gitText(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/other')
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'rev-parse', 'refs/heads/main')).toBe(started.snapshot.result.commitId)
  }, 60_000)

  it('recovers an acknowledged-lost attached Commit after its target branch advances', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'c',
      17,
      'recoverable contents\n',
      'recoverable attached commit\n',
    )
    const persistence = operationPersistence(execution)
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'succeeded') {
        throw new Error('simulated attached Commit acknowledgement loss')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated attached Commit acknowledgement loss')
    persistence.restore()
    const publishedCommit = await gitText(root, 'rev-parse', 'refs/heads/main')
    await git(root, 'commit', '--allow-empty', '-m', 'later attached commit')
    expect(await gitText(root, 'rev-parse', 'refs/heads/main')).not.toBe(publishedCommit)

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
      result: {
        type: 'commit',
        commitId: publishedCommit,
        target: { kind: 'symbolic-ref', ref: 'refs/heads/main' },
      },
    })
  }, 60_000)

  it('bounds an acknowledged-lost Commit reflog before reading it', async () => {
    const root = await repository()
    const reflogReadLimit = 4 * 1024
    const reflogPath = join(root, '.git', 'logs', 'refs', 'heads', 'main')
    const state = { armed: false, openCalls: 0, readCalls: 0 }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (!state.armed || path !== reflogPath || flags !== 'r') return handle
        state.openCalls += 1
        return {
          ...handle,
          async read(buffer, offset, length, position) {
            state.readCalls += 1
            return await handle.read(buffer, offset, length, position)
          },
        }
      },
    }
    const execution = await provider(root, { node, config: { operationMaxReflogBytes: reflogReadLimit } })
    const signal = new AbortController().signal
    const { prepared, durable } = await captureAcknowledgedLostAttachedCommit(
      execution,
      root,
      signal,
      '1',
      27,
    )
    await writeFile(
      reflogPath,
      Buffer.alloc(reflogReadLimit + 1, 0x78),
      { flag: 'a' },
    )
    state.armed = true
    expect(durable.effectPlan.reflogReadLimit).toBe(reflogReadLimit)
    const runtime = execution as unknown as { config: { operationMaxReflogBytes: number } }
    runtime.config.operationMaxReflogBytes = CONFIG.operationMaxReflogBytes

    expect((await stat(reflogPath)).size).toBeGreaterThan(reflogReadLimit)
    expect((await stat(reflogPath)).size).toBeLessThan(CONFIG.operationMaxReflogBytes)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'reconciliation-required',
      reason: 'effect-unknown',
    })
    expect(state).toEqual({ armed: true, openCalls: 0, readCalls: 0 })
  }, 60_000)

  it('recovers an acknowledged-lost Commit with its frozen reflog bound after live config shrinks', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, durable, publishedCommit, reflogPath } = await captureAcknowledgedLostAttachedCommit(
      execution,
      root,
      signal,
      '0',
      38,
    )
    const reflogSize = (await stat(reflogPath)).size
    expect(reflogSize).toBeGreaterThan(1)
    expect(durable.effectPlan.reflogReadLimit).toBe(CONFIG.operationMaxReflogBytes)
    const runtime = execution as unknown as { config: { operationMaxReflogBytes: number } }
    const originalBound = runtime.config.operationMaxReflogBytes
    runtime.config.operationMaxReflogBytes = 1

    const recovered = await execution.inspectOperation(
      prepared.preparation.operation,
      signal,
    ).finally(() => { runtime.config.operationMaxReflogBytes = originalBound })

    expect(recovered).toMatchObject({
      state: 'succeeded',
      result: { type: 'commit', commitId: publishedCommit },
    })
  }, 60_000)

  it('bounds reflog growth that races an acknowledged-lost Commit inspection', async () => {
    const root = await repository()
    const reflogPath = join(root, '.git', 'logs', 'refs', 'heads', 'main')
    const state = { grew: false, readEnds: [] as number[] }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (path !== reflogPath || flags !== 'r') return handle
        return {
          ...handle,
          async stat() {
            const observed = await handle.stat()
            if (!state.grew) {
              state.grew = true
              await writeFile(
                path,
                Buffer.alloc(CONFIG.operationMaxReflogBytes + 1, 0x79),
                { flag: 'a' },
              )
            }
            return observed
          },
          async read(buffer, offset, length, position) {
            state.readEnds.push(position + length)
            return await handle.read(buffer, offset, length, position)
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await captureAcknowledgedLostAttachedCommit(
      execution,
      root,
      signal,
      '2',
      28,
    )

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'reconciliation-required',
      reason: 'effect-unknown',
    })
    expect(state.grew).toBe(true)
    expect(state.readEnds.length).toBeGreaterThan(0)
    expect(Math.max(...state.readEnds)).toBeLessThanOrEqual(CONFIG.operationMaxReflogBytes)
  }, 60_000)

  it('rejects a reflog pathname replacement after reading its opened file', async () => {
    const root = await repository()
    const reflogPath = join(root, '.git', 'logs', 'refs', 'heads', 'main')
    const retainedPath = `${reflogPath}.retained`
    let replaced = false
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (path !== reflogPath || flags !== 'r') return handle
        return {
          ...handle,
          async stat() {
            const observed = await handle.stat()
            if (!replaced) {
              replaced = true
              await rename(path, retainedPath)
              await writeFile(path, 'foreign reflog\n')
            }
            return observed
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared, publishedCommit } = await captureAcknowledgedLostAttachedCommit(
      execution,
      root,
      signal,
      '3',
      29,
    )

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'publishing',
    })
    expect(replaced).toBe(true)
    await unlink(reflogPath)
    await rename(retainedPath, reflogPath)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
      result: { type: 'commit', commitId: publishedCommit },
    })
  }, 60_000)

  it.each([
    { name: 'missing pathname', kind: 'missing', outcome: 'evidence-conflict' },
    { name: 'directory pathname', kind: 'directory', outcome: 'publishing' },
    { name: 'initial reflog lstat failure', kind: 'initial-lstat-eio', outcome: 'publishing' },
    { name: 'opened identity drift', kind: 'open-identity-drift', outcome: 'publishing' },
    { name: 'opened oversized file', kind: 'opened-oversize', outcome: 'effect-unknown' },
    { name: 'short handle read', kind: 'short-read', outcome: 'publishing' },
    { name: 'unterminated record', kind: 'no-trailing-newline', outcome: 'publishing' },
    { name: 'handle open failure', kind: 'open-failure', outcome: 'publishing' },
  ] as const)('classifies an acknowledged-lost Commit reflog with $name', async ({ kind, outcome }) => {
    const root = await repository()
    const reflogPath = join(root, '.git', 'logs', 'refs', 'heads', 'main')
    const retainedPath = `${reflogPath}.opened-original`
    const oversizedBytes = kind === 'opened-oversize'
      ? Buffer.alloc(CONFIG.operationMaxReflogBytes + 1, 0x7a)
      : undefined
    const state = {
      armed: false,
      injected: false,
      initialLstatFailures: 0,
      openCalls: 0,
      openedHandles: 0,
      closedHandles: 0,
      readCalls: 0,
      openedSize: undefined as bigint | undefined,
    }
    const delegate = scratchRootTrackingNodeAdapter()
    const node: LocalGitMutationNodeAdapter = {
      ...delegate,
      async lstat(path) {
        if (state.armed && !state.injected && kind === 'initial-lstat-eio' && path === reflogPath) {
          state.injected = true
          state.initialLstatFailures += 1
          throw Object.assign(new Error('injected initial reflog lstat failure'), {
            code: 'EIO',
            errno: -5,
            syscall: 'lstat',
            path,
          })
        }
        return await delegate.lstat(path)
      },
      async open(path, flags, mode) {
        if (!state.armed || path !== reflogPath || flags !== 'r') {
          return await delegate.open(path, flags, mode)
        }
        state.openCalls += 1
        if (kind === 'open-failure') {
          state.injected = true
          throw Object.assign(new Error('injected reflog open failure'), {
            code: 'EIO',
            errno: -5,
            syscall: 'open',
          })
        }
        if (kind === 'open-identity-drift') {
          await rename(path, retainedPath)
          await writeFile(path, 'foreign reflog\n')
          state.injected = true
        } else if (kind === 'opened-oversize') {
          if (oversizedBytes === undefined) throw new Error('test retained no oversized reflog bytes')
          await rename(path, retainedPath)
          await writeFile(path, oversizedBytes, { flag: 'wx' })
          state.injected = true
        }
        const handle = await delegate.open(path, flags, mode)
        state.openedHandles += 1
        const trackedHandle: typeof handle = {
          ...handle,
          async stat() {
            const info = await handle.stat()
            if (kind === 'opened-oversize') state.openedSize = info.size
            return info
          },
          async read(buffer, offset, length, position) {
            state.readCalls += 1
            if (kind === 'short-read') {
              state.injected = true
              return { bytesRead: 0 }
            }
            return await handle.read(buffer, offset, length, position)
          },
          async close() {
            state.closedHandles += 1
            await handle.close()
          },
        }
        return trackedHandle
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared, durable, publishedCommit } = await captureAcknowledgedLostAttachedCommit(
      execution,
      root,
      signal,
      '4',
      30,
    )
    const protectedCase = kind === 'initial-lstat-eio' || kind === 'opened-oversize'
    const scratch = durable.effectPlan.scratch
    const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
    const witnessPath = `${quarantinePath}.owner`
    const indexPath = join(root, '.git', 'index')
    const lockPath = `${indexPath}.lock`
    const protectedEvidence = protectedCase
      ? {
        laterTip: await gitText(root, 'rev-parse', 'refs/heads/main'),
        head: await gitText(root, 'rev-parse', 'HEAD'),
        symbolicHead: await gitText(root, 'symbolic-ref', 'HEAD'),
        indexBytes: await readFile(indexPath),
        indexInfo: await stat(indexPath, { bigint: true }),
        cachedDiff: await gitText(root, 'diff', '--cached', '--name-only'),
        worktreeDiff: await gitText(root, 'diff', '--name-only'),
        reflogBytes: await readFile(reflogPath),
        reflogInfo: await stat(reflogPath, { bigint: true }),
        scratchInfo: await stat(scratch.path, { bigint: true }),
        ownerBytes: await readFile(join(scratch.path, 'owner')),
        ownerInfo: await stat(join(scratch.path, 'owner'), { bigint: true }),
        payloadIndex: await readFile(join(scratch.path, 'payload', 'commit.index')),
        pinBytes: await readFile(durable.effectPlan.pin.path),
        pinInfo: await stat(durable.effectPlan.pin.path, { bigint: true }),
      }
      : undefined
    if (protectedEvidence !== undefined) {
      if (!roots.includes(quarantinePath)) roots.push(quarantinePath, witnessPath)
      expect(protectedEvidence.reflogInfo.isFile()).toBe(true)
      expect(protectedEvidence.reflogInfo.isSymbolicLink()).toBe(false)
      if (kind === 'opened-oversize') {
        expect(protectedEvidence.reflogInfo.size).toBeLessThanOrEqual(BigInt(CONFIG.operationMaxReflogBytes))
      }
    }
    state.armed = true
    if (kind === 'missing') {
      await unlink(reflogPath)
      state.injected = true
    } else if (kind === 'directory') {
      await unlink(reflogPath)
      await mkdir(reflogPath)
      state.injected = true
    } else if (kind === 'no-trailing-newline') {
      const matching = (await readFile(reflogPath, 'utf8'))
        .split(/\r?\n/u)
        .find(line => line.includes('\tsaki host-operation '))
      if (matching === undefined) throw new Error('test reflog retained no operation record')
      await writeFile(reflogPath, matching)
      state.injected = true
    }

    const expectProtectedGitWorld = async (): Promise<void> => {
      if (protectedEvidence === undefined) throw new Error('test retained no protected Git world')
      await expect(readFile(indexPath)).resolves.toEqual(protectedEvidence.indexBytes)
      expect(await stat(indexPath, { bigint: true })).toMatchObject({
        dev: protectedEvidence.indexInfo.dev,
        ino: protectedEvidence.indexInfo.ino,
        mode: protectedEvidence.indexInfo.mode,
      })
      expect(await gitText(root, 'rev-parse', 'refs/heads/main')).toBe(protectedEvidence.laterTip)
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(protectedEvidence.head)
      expect(await gitText(root, 'symbolic-ref', 'HEAD')).toBe(protectedEvidence.symbolicHead)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe(protectedEvidence.cachedDiff)
      expect(await gitText(root, 'diff', '--name-only')).toBe(protectedEvidence.worktreeDiff)
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const expectOriginalReflog = async (path: string): Promise<void> => {
      if (protectedEvidence === undefined) throw new Error('test retained no original reflog evidence')
      await expect(readFile(path)).resolves.toEqual(protectedEvidence.reflogBytes)
      expect(await stat(path, { bigint: true })).toMatchObject({
        dev: protectedEvidence.reflogInfo.dev,
        ino: protectedEvidence.reflogInfo.ino,
        mode: protectedEvidence.reflogInfo.mode,
        size: protectedEvidence.reflogInfo.size,
      })
    }

    if (kind === 'initial-lstat-eio') {
      if (protectedEvidence === undefined) throw new Error('test retained no initial lstat evidence')
      const inspected = await execution.inspectOperation(prepared.preparation.operation, signal)
      expect(inspected).toMatchObject({ state: 'publishing' })
      expect(state).toMatchObject({
        injected: true,
        initialLstatFailures: 1,
        openCalls: 0,
        openedHandles: 0,
        closedHandles: 0,
        readCalls: 0,
      })
      const retainedScratch = await stat(scratch.path, { bigint: true })
      expect({ device: retainedScratch.dev.toString(), inode: retainedScratch.ino.toString() }).toEqual(
        scratch.identity,
      )
      expect(retainedScratch).toMatchObject({
        dev: protectedEvidence.scratchInfo.dev,
        ino: protectedEvidence.scratchInfo.ino,
        mode: protectedEvidence.scratchInfo.mode,
      })
      const retainedOwner = await stat(join(scratch.path, 'owner'), { bigint: true })
      expect({ device: retainedOwner.dev.toString(), inode: retainedOwner.ino.toString() }).toEqual(
        scratch.ownerIdentity,
      )
      expect(retainedOwner).toMatchObject({
        dev: protectedEvidence.ownerInfo.dev,
        ino: protectedEvidence.ownerInfo.ino,
        mode: protectedEvidence.ownerInfo.mode,
      })
      await expect(readFile(join(scratch.path, 'owner'))).resolves.toEqual(protectedEvidence.ownerBytes)
      await expect(readFile(join(scratch.path, 'payload', 'commit.index'))).resolves.toEqual(
        protectedEvidence.payloadIndex,
      )
      expect(await stat(durable.effectPlan.pin.path, { bigint: true })).toMatchObject({
        dev: protectedEvidence.pinInfo.dev,
        ino: protectedEvidence.pinInfo.ino,
        mode: protectedEvidence.pinInfo.mode,
      })
      await expect(readFile(durable.effectPlan.pin.path)).resolves.toEqual(protectedEvidence.pinBytes)
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expectProtectedGitWorld()
      await expectOriginalReflog(reflogPath)

      state.armed = false
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({
        state: 'succeeded',
        result: { type: 'commit', commitId: publishedCommit },
      })
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expectProtectedGitWorld()
      await expectOriginalReflog(reflogPath)
      return
    }

    if (kind === 'opened-oversize') {
      if (protectedEvidence === undefined || oversizedBytes === undefined) {
        throw new Error('test retained no opened oversize evidence')
      }
      try {
        const inspected = await execution.inspectOperation(prepared.preparation.operation, signal)
        expect(inspected).toMatchObject({ state: 'reconciliation-required', reason: 'effect-unknown' })
        expect(state).toMatchObject({
          injected: true,
          initialLstatFailures: 0,
          openCalls: 1,
          openedHandles: 1,
          closedHandles: 1,
          readCalls: 0,
          openedSize: BigInt(CONFIG.operationMaxReflogBytes + 1),
        })
        const foreign = await stat(reflogPath, { bigint: true })
        expect(foreign.isFile()).toBe(true)
        expect(foreign.isSymbolicLink()).toBe(false)
        expect(foreign.size).toBe(BigInt(CONFIG.operationMaxReflogBytes + 1))
        expect({ device: foreign.dev, inode: foreign.ino }).not.toEqual({
          device: protectedEvidence.reflogInfo.dev,
          inode: protectedEvidence.reflogInfo.ino,
        })
        await expect(readFile(reflogPath)).resolves.toEqual(oversizedBytes)
        await expectOriginalReflog(retainedPath)
        await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expectProtectedGitWorld()
      } finally {
        state.armed = false
        if (state.injected) {
          await rm(reflogPath, { force: true })
          await rename(retainedPath, reflogPath)
        }
      }
      await expectOriginalReflog(reflogPath)
      return
    }

    const inspected = await execution.inspectOperation(prepared.preparation.operation, signal)

    expect(state.injected).toBe(true)
    expect(inspected).toMatchObject(outcome === 'publishing'
      ? { state: 'publishing' }
      : { state: 'reconciliation-required', reason: outcome })
    const expectedOpenCalls = kind === 'missing' || kind === 'directory' ? 0 : 1
    const expectedOpenedHandles = kind === 'open-failure' ? 0 : expectedOpenCalls
    expect(state.openCalls).toBe(expectedOpenCalls)
    expect(state.openedHandles).toBe(expectedOpenedHandles)
    expect(state.closedHandles).toBe(expectedOpenedHandles)
    if (kind === 'open-identity-drift') {
      expect(await readFile(retainedPath, 'utf8')).toContain('\tsaki host-operation ')
      await expect(readFile(reflogPath, 'utf8')).resolves.toBe('foreign reflog\n')
    }
    if (outcome !== 'publishing') {
      await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await expect(stat(durable.effectPlan.scratch.path)).resolves.toBeDefined()
    }
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it.runIf(process.platform !== 'win32')(
    'keeps an acknowledged-lost Commit retryable when its opened reflog is a directory',
    async () => {
      const root = await repository()
      const reflogPath = join(root, '.git', 'logs', 'refs', 'heads', 'main')
      const retainedPath = `${reflogPath}.opened-directory-original`
      const state = {
        armed: false,
        injected: false,
        openCalls: 0,
        statCalls: 0,
        readCalls: 0,
        closeCalls: 0,
        openedDirectory: false,
        readFailure: undefined as unknown,
      }
      const delegate = scratchRootTrackingNodeAdapter()
      const node: LocalGitMutationNodeAdapter = {
        ...delegate,
        async open(path, flags, mode) {
          if (!state.armed || path !== reflogPath || flags !== 'r') {
            return await delegate.open(path, flags, mode)
          }
          state.openCalls += 1
          await rename(path, retainedPath)
          await mkdir(path)
          state.injected = true
          const handle = await delegate.open(path, flags, mode)
          return {
            ...handle,
            async stat() {
              state.statCalls += 1
              const info = await handle.stat()
              state.openedDirectory = info.isDirectory()
              return info
            },
            async read(buffer, offset, length, position) {
              state.readCalls += 1
              try {
                return await handle.read(buffer, offset, length, position)
              } catch (error) {
                state.readFailure = error
                throw error
              }
            },
            async close() {
              state.closeCalls += 1
              await handle.close()
            },
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable, publishedCommit } = await captureAcknowledgedLostAttachedCommit(
        execution,
        root,
        signal,
        '5',
        31,
      )
      const scratch = durable.effectPlan.scratch
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      if (!roots.includes(quarantinePath)) roots.push(quarantinePath, witnessPath)
      const ownerPath = join(scratch.path, 'owner')
      const payloadPath = join(scratch.path, 'payload', 'commit.index')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const evidence = {
        scratchInfo: await stat(scratch.path, { bigint: true }),
        ownerInfo: await stat(ownerPath, { bigint: true }),
        ownerBytes: await readFile(ownerPath),
        payloadInfo: await stat(payloadPath, { bigint: true }),
        payloadBytes: await readFile(payloadPath),
        pinInfo: await stat(durable.effectPlan.pin.path, { bigint: true }),
        pinBytes: await readFile(durable.effectPlan.pin.path),
        indexInfo: await stat(indexPath, { bigint: true }),
        indexBytes: await readFile(indexPath),
        mainRef: await gitText(root, 'rev-parse', 'refs/heads/main'),
        head: await gitText(root, 'rev-parse', 'HEAD'),
        symbolicHead: await gitText(root, 'symbolic-ref', 'HEAD'),
        cachedDiff: await gitText(root, 'diff', '--cached', '--name-only'),
        worktreeDiff: await gitText(root, 'diff', '--name-only'),
        reflogInfo: await stat(reflogPath, { bigint: true }),
        reflogBytes: await readFile(reflogPath),
      }
      expect(evidence.reflogInfo.isFile()).toBe(true)
      expect(evidence.reflogInfo.isSymbolicLink()).toBe(false)
      state.armed = true

      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'publishing' })

      expect(liveOperationCount(execution)).toBe(1)
      expect(state).toMatchObject({
        injected: true,
        openCalls: 1,
        statCalls: 1,
        readCalls: 0,
        closeCalls: 1,
        openedDirectory: true,
        readFailure: undefined,
      })
      const foreign = await stat(reflogPath, { bigint: true })
      expect(foreign.isDirectory()).toBe(true)
      expect(foreign.isSymbolicLink()).toBe(false)
      expect(await readdir(reflogPath)).toEqual([])
      await expect(readFile(retainedPath)).resolves.toEqual(evidence.reflogBytes)
      expect(await stat(retainedPath, { bigint: true })).toMatchObject({
        dev: evidence.reflogInfo.dev,
        ino: evidence.reflogInfo.ino,
        mode: evidence.reflogInfo.mode,
        size: evidence.reflogInfo.size,
      })
      expect(evidence.reflogBytes.toString('utf8')).toContain('\tsaki host-operation ')
      expect(await stat(scratch.path, { bigint: true })).toMatchObject({
        dev: evidence.scratchInfo.dev,
        ino: evidence.scratchInfo.ino,
        mode: evidence.scratchInfo.mode,
      })
      expect(await stat(ownerPath, { bigint: true })).toMatchObject({
        dev: evidence.ownerInfo.dev,
        ino: evidence.ownerInfo.ino,
        mode: evidence.ownerInfo.mode,
      })
      await expect(readFile(ownerPath)).resolves.toEqual(evidence.ownerBytes)
      expect(await stat(payloadPath, { bigint: true })).toMatchObject({
        dev: evidence.payloadInfo.dev,
        ino: evidence.payloadInfo.ino,
        mode: evidence.payloadInfo.mode,
      })
      await expect(readFile(payloadPath)).resolves.toEqual(evidence.payloadBytes)
      expect(await stat(durable.effectPlan.pin.path, { bigint: true })).toMatchObject({
        dev: evidence.pinInfo.dev,
        ino: evidence.pinInfo.ino,
        mode: evidence.pinInfo.mode,
      })
      await expect(readFile(durable.effectPlan.pin.path)).resolves.toEqual(evidence.pinBytes)
      await expect(readFile(indexPath)).resolves.toEqual(evidence.indexBytes)
      expect(await stat(indexPath, { bigint: true })).toMatchObject({
        dev: evidence.indexInfo.dev,
        ino: evidence.indexInfo.ino,
        mode: evidence.indexInfo.mode,
      })
      expect(await gitText(root, 'rev-parse', 'refs/heads/main')).toBe(evidence.mainRef)
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(evidence.head)
      expect(await gitText(root, 'symbolic-ref', 'HEAD')).toBe(evidence.symbolicHead)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe(evidence.cachedDiff)
      expect(await gitText(root, 'diff', '--name-only')).toBe(evidence.worktreeDiff)
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      state.armed = false
      await rmdir(reflogPath)
      await rename(retainedPath, reflogPath)
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({
        state: 'succeeded',
        result: { type: 'commit', commitId: publishedCommit },
      })
      expect(liveOperationCount(execution)).toBe(0)
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(indexPath)).resolves.toEqual(evidence.indexBytes)
      expect(await stat(indexPath, { bigint: true })).toMatchObject({
        dev: evidence.indexInfo.dev,
        ino: evidence.indexInfo.ino,
        mode: evidence.indexInfo.mode,
      })
      expect(await gitText(root, 'rev-parse', 'refs/heads/main')).toBe(evidence.mainRef)
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(evidence.head)
      expect(await gitText(root, 'symbolic-ref', 'HEAD')).toBe(evidence.symbolicHead)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe(evidence.cachedDiff)
      expect(await gitText(root, 'diff', '--name-only')).toBe(evidence.worktreeDiff)
      await expect(readFile(reflogPath)).resolves.toEqual(evidence.reflogBytes)
      expect(await stat(reflogPath, { bigint: true })).toMatchObject({
        dev: evidence.reflogInfo.dev,
        ino: evidence.reflogInfo.ino,
        mode: evidence.reflogInfo.mode,
        size: evidence.reflogInfo.size,
      })
    },
    90_000,
  )

  it('preserves caller abort after a real reflog handle stat failure', async () => {
    const root = await repository()
    const reflogPath = join(root, '.git', 'logs', 'refs', 'heads', 'main')
    const controller = new AbortController()
    const abortReason = new Error('caller aborted after reflog fstat')
    const lowerFailure = new Error('reflog fstat continuation failed after caller abort')
    const state = {
      armed: false,
      injected: false,
      openCalls: 0,
      statCalls: 0,
      readCalls: 0,
      closeCalls: 0,
      openedRegularFile: false,
    }
    const delegate = scratchRootTrackingNodeAdapter()
    const node: LocalGitMutationNodeAdapter = {
      ...delegate,
      async open(path, flags, mode) {
        const handle = await delegate.open(path, flags, mode)
        if (!state.armed || path !== reflogPath || flags !== 'r') return handle
        state.openCalls += 1
        return {
          ...handle,
          async stat() {
            state.statCalls += 1
            const info = await handle.stat()
            state.openedRegularFile = info.isFile() && !info.isSymbolicLink()
            state.injected = true
            controller.abort(abortReason)
            throw lowerFailure
          },
          async read(buffer, offset, length, position) {
            state.readCalls += 1
            return await handle.read(buffer, offset, length, position)
          },
          async close() {
            state.closeCalls += 1
            await handle.close()
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const { prepared, durable, publishedCommit } = await captureAcknowledgedLostAttachedCommit(
      execution,
      root,
      controller.signal,
      '6',
      32,
    )
    const scratch = durable.effectPlan.scratch
    const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
    const witnessPath = `${quarantinePath}.owner`
    if (!roots.includes(quarantinePath)) roots.push(quarantinePath, witnessPath)
    const ownerPath = join(scratch.path, 'owner')
    const payloadPath = join(scratch.path, 'payload', 'commit.index')
    const indexPath = join(root, '.git', 'index')
    const lockPath = `${indexPath}.lock`
    const evidence = {
      scratchInfo: await stat(scratch.path, { bigint: true }),
      ownerInfo: await stat(ownerPath, { bigint: true }),
      ownerBytes: await readFile(ownerPath),
      payloadInfo: await stat(payloadPath, { bigint: true }),
      payloadBytes: await readFile(payloadPath),
      pinInfo: await stat(durable.effectPlan.pin.path, { bigint: true }),
      pinBytes: await readFile(durable.effectPlan.pin.path),
      indexInfo: await stat(indexPath, { bigint: true }),
      indexBytes: await readFile(indexPath),
      mainRef: await gitText(root, 'rev-parse', 'refs/heads/main'),
      head: await gitText(root, 'rev-parse', 'HEAD'),
      symbolicHead: await gitText(root, 'symbolic-ref', 'HEAD'),
      cachedDiff: await gitText(root, 'diff', '--cached', '--name-only'),
      worktreeDiff: await gitText(root, 'diff', '--name-only'),
      reflogInfo: await stat(reflogPath, { bigint: true }),
      reflogBytes: await readFile(reflogPath),
    }
    expect(evidence.reflogInfo.isFile()).toBe(true)
    expect(evidence.reflogInfo.isSymbolicLink()).toBe(false)
    state.armed = true

    await expect(execution.inspectOperation(
      prepared.preparation.operation,
      controller.signal,
    )).rejects.toBe(abortReason)

    expect(controller.signal.reason).toBe(abortReason)
    expect(lowerFailure).not.toBe(abortReason)
    expect(liveOperationCount(execution)).toBe(1)
    expect(state).toEqual({
      armed: true,
      injected: true,
      openCalls: 1,
      statCalls: 1,
      readCalls: 0,
      closeCalls: 1,
      openedRegularFile: true,
    })
    expect(await stat(scratch.path, { bigint: true })).toMatchObject({
      dev: evidence.scratchInfo.dev,
      ino: evidence.scratchInfo.ino,
      mode: evidence.scratchInfo.mode,
    })
    expect(await stat(ownerPath, { bigint: true })).toMatchObject({
      dev: evidence.ownerInfo.dev,
      ino: evidence.ownerInfo.ino,
      mode: evidence.ownerInfo.mode,
    })
    await expect(readFile(ownerPath)).resolves.toEqual(evidence.ownerBytes)
    expect(await stat(payloadPath, { bigint: true })).toMatchObject({
      dev: evidence.payloadInfo.dev,
      ino: evidence.payloadInfo.ino,
      mode: evidence.payloadInfo.mode,
    })
    await expect(readFile(payloadPath)).resolves.toEqual(evidence.payloadBytes)
    expect(await stat(durable.effectPlan.pin.path, { bigint: true })).toMatchObject({
      dev: evidence.pinInfo.dev,
      ino: evidence.pinInfo.ino,
      mode: evidence.pinInfo.mode,
    })
    await expect(readFile(durable.effectPlan.pin.path)).resolves.toEqual(evidence.pinBytes)
    await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(indexPath)).resolves.toEqual(evidence.indexBytes)
    expect(await stat(indexPath, { bigint: true })).toMatchObject({
      dev: evidence.indexInfo.dev,
      ino: evidence.indexInfo.ino,
      mode: evidence.indexInfo.mode,
    })
    expect(await gitText(root, 'rev-parse', 'refs/heads/main')).toBe(evidence.mainRef)
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(evidence.head)
    expect(await gitText(root, 'symbolic-ref', 'HEAD')).toBe(evidence.symbolicHead)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe(evidence.cachedDiff)
    expect(await gitText(root, 'diff', '--name-only')).toBe(evidence.worktreeDiff)
    await expect(readFile(reflogPath)).resolves.toEqual(evidence.reflogBytes)
    expect(await stat(reflogPath, { bigint: true })).toMatchObject({
      dev: evidence.reflogInfo.dev,
      ino: evidence.reflogInfo.ino,
      mode: evidence.reflogInfo.mode,
      size: evidence.reflogInfo.size,
    })

    state.armed = false
    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      new AbortController().signal,
    )).toMatchObject({
      state: 'succeeded',
      result: { type: 'commit', commitId: publishedCommit },
    })
    expect(liveOperationCount(execution)).toBe(0)
    await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(indexPath)).resolves.toEqual(evidence.indexBytes)
    expect(await stat(indexPath, { bigint: true })).toMatchObject({
      dev: evidence.indexInfo.dev,
      ino: evidence.indexInfo.ino,
      mode: evidence.indexInfo.mode,
    })
    expect(await gitText(root, 'rev-parse', 'refs/heads/main')).toBe(evidence.mainRef)
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(evidence.head)
    expect(await gitText(root, 'symbolic-ref', 'HEAD')).toBe(evidence.symbolicHead)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe(evidence.cachedDiff)
    expect(await gitText(root, 'diff', '--name-only')).toBe(evidence.worktreeDiff)
    await expect(readFile(reflogPath)).resolves.toEqual(evidence.reflogBytes)
    expect(await stat(reflogPath, { bigint: true })).toMatchObject({
      dev: evidence.reflogInfo.dev,
      ino: evidence.reflogInfo.ino,
      mode: evidence.reflogInfo.mode,
      size: evidence.reflogInfo.size,
    })
  }, 90_000)

  it.each([
    { name: 'keeps the matching evidence', abortOnClose: false },
    { name: 'preserves abort priority', abortOnClose: true },
  ] as const)('ignores a reflog handle close rejection and $name', async ({ abortOnClose }) => {
    const root = await repository()
    const reflogPath = join(root, '.git', 'logs', 'refs', 'heads', 'main')
    const controller = new AbortController()
    const abortReason = new Error('reflog close abort wins')
    const closeFailure = new Error('injected reflog close rejection')
    const state = { armed: false, closeCalls: 0 }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (!state.armed || path !== reflogPath || flags !== 'r') return handle
        return {
          ...handle,
          async close() {
            state.closeCalls += 1
            await handle.close()
            if (abortOnClose) controller.abort(abortReason)
            throw closeFailure
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const { prepared, publishedCommit } = await captureAcknowledgedLostAttachedCommit(
      execution,
      root,
      controller.signal,
      abortOnClose ? '6' : '5',
      abortOnClose ? 32 : 31,
    )
    state.armed = true

    if (abortOnClose) {
      await expect(execution.inspectOperation(
        prepared.preparation.operation,
        controller.signal,
      )).rejects.toBe(abortReason)
    } else {
      await expect(execution.inspectOperation(
        prepared.preparation.operation,
        controller.signal,
      )).resolves.toMatchObject({
        state: 'succeeded',
        result: { type: 'commit', commitId: publishedCommit },
      })
    }
    expect(state.closeCalls).toBeGreaterThan(0)
  }, 90_000)

  it('rejects a detached Commit during Host preparation without changing HEAD', async () => {
    const root = await repository()
    await git(root, 'checkout', '--detach')
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'detached\n')
    await git(root, 'add', '--', 'tracked.txt')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') return
    expect(inspected.observation).toMatchObject({
      branch: { kind: 'detached' },
      structuredMutation: { available: true, blockers: [] },
    })
    const request: CommitHostOperationRequest = {
      type: 'commit',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: 'a'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      message: 'detached commit\n',
    }
    const admission = acceptedAdmission(15)
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared).toEqual({ ok: false, reason: 'unavailable' })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    await expect(run('git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: root,
      windowsHide: true,
    })).rejects.toMatchObject({ code: 1 })
  }, 45_000)

  it('initializes the durable operations table when migrating an empty snapshot', () => {
    const migratedV2 = sakiHostExecutionDomainMigrations.steps[0]!.migrate({
      tables: {},
      global: null,
    })
    expect(migratedV2).toEqual({ tables: { operations: {} }, global: null })
    expect(sakiHostExecutionDomainMigrations.steps[1]!.migrate({ tables: {}, global: null }))
      .toEqual({ tables: { operations: {} }, global: null })
    expect(sakiHostExecutionDomainMigrations.steps[2]!.migrate({ tables: {}, global: null }))
      .toEqual({ tables: { operations: {} }, global: null })
    expect(sakiHostExecutionV3DomainSpec.version).toBe(3)
    expect(sakiHostExecutionDomainSpec.version).toBe(4)
  })

  it('fails a replayed historical detached Commit before effect', async () => {
    const root = await repository()
    await git(root, 'checkout', '--detach')
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'historical detached\n')
    await git(root, 'add', '--', 'tracked.txt')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') return
    const request: CommitHostOperationRequest = {
      type: 'commit',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: 'b'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      message: 'historical detached commit\n',
    }
    const requestFingerprint = localHostOperationRequestFingerprint(request)
    const preparedAt = Date.now()
    const operation = {
      id: 'host-operation-11111111-1111-4111-8111-111111111111' as const,
      hostId: HOST_ID,
      type: 'commit' as const,
    }
    const historicalRecord = sakiHostExecutionV1DomainSpec.tables.operations.valueSchema.parse({
      schemaVersion: 1,
      request,
      preparationRevision: 0,
      snapshot: {
        operation,
        revision: 0,
        source: request.source,
        requestFingerprint,
        bindingId: binding.id,
        bindingRevision: binding.revision,
        preparedAt,
        updatedAt: preparedAt,
        state: 'prepared',
        admission: { kind: 'not-accepted' },
      },
    })
    const migratedV2 = sakiHostExecutionDomainMigrations.steps[0]!.migrate({
      tables: { operations: { [operation.id]: historicalRecord } },
      global: null,
    })
    const versionTwoRecord = sakiHostExecutionV2DomainSpec.tables.operations.valueSchema.parse(
      migratedV2.tables['operations']![operation.id],
    )
    expect(versionTwoRecord).toEqual({ ...historicalRecord, schemaVersion: 2 })
    const migratedV3 = sakiHostExecutionDomainMigrations.steps[1]!.migrate(migratedV2)
    const versionThreeRecord = sakiHostExecutionV3DomainSpec.tables.operations.valueSchema.parse(
      migratedV3.tables['operations']![operation.id],
    )
    expect(versionThreeRecord).toEqual({ ...historicalRecord, schemaVersion: 3 })
    const migrated = sakiHostExecutionDomainMigrations.steps[2]!.migrate(migratedV3)
    const record = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse(
      migrated.tables['operations']![operation.id],
    )
    expect(record).toEqual({ ...historicalRecord, schemaVersion: 4 })
    expect(record.request).toEqual(historicalRecord.request)
    expect(record.snapshot.requestFingerprint).toEqual(historicalRecord.snapshot.requestFingerprint)
    const operationTable = (execution as unknown as {
      operationTable: { put: (id: typeof operation.id, value: LocalHostOperationRecord) => Promise<void> }
    }).operationTable
    await operationTable.put(operation.id, record)
    const admission = acceptedAdmission(15)
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  }, 45_000)

  it('fails a historical durable detached not-started Commit without resuming its effect', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'b', 16, 'historical candidate\n', 'historical detached commit\n',
    )
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
        throw new Error('captured historical Commit plan')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('captured historical Commit plan')
    persistence.restore()
    if (durable === undefined) throw new Error('test retained no historical Commit plan')
    const historical = await asHistoricalDetached(durable)
    await persistence.original(historical)
    await git(root, 'checkout', '--detach')

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'failed',
      failure: { reason: 'unsupported-state' },
      effect: 'none',
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  }, 60_000)

  it('does not recover a historical detached Commit from a symbolic HEAD at its candidate', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'b', 16, 'historical symbolic candidate\n', 'historical symbolic commit\n',
    )
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        durable = record
        throw new Error('captured historical symbolic Commit')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('captured historical symbolic Commit')
    persistence.restore()
    if (durable === undefined) throw new Error('test retained no attempted Commit plan')
    const historical = await asHistoricalDetached(durable)
    if (historical.effectPlan?.kind !== 'commit') throw new Error('test retained no detached Commit plan')
    await persistence.original(historical)
    await git(
      root,
      'update-ref', '-m', 'unrelated symbolic candidate',
      'refs/heads/main', historical.effectPlan.result.commitId, parent,
    )
    expect(await gitText(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(historical.effectPlan.result.commitId)

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'reconciliation-required',
      reason: 'evidence-conflict',
    })
  }, 60_000)

  it('read-only recovers a historical detached Commit with applied attempted evidence', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'b', 16, 'historical applied candidate\n', 'historical applied commit\n',
    )
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        durable = record
        throw new Error('captured historical attempted Commit')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('captured historical attempted Commit')
    persistence.restore()
    if (durable === undefined) throw new Error('test retained no attempted Commit plan')
    const historical = await asHistoricalDetached(durable)
    if (historical.effectPlan?.kind !== 'commit') throw new Error('test retained no detached Commit plan')
    expectOperationRecordIssue({
      ...historical,
      effectPlan: { ...historical.effectPlan, targetRef: 'refs/heads/main' },
    }, 'detached Commit effect plan disagrees with expected HEAD')
    await persistence.original(historical)
    await git(root, 'checkout', '--detach')
    await git(
      root,
      'update-ref', '--no-deref', '--create-reflog', '-m', historical.effectPlan.reflogMarker,
      'HEAD', historical.effectPlan.result.commitId, parent,
    )
    await git(
      root,
      'update-ref', '-m', 'later symbolic candidate',
      'refs/heads/main', historical.effectPlan.result.commitId, parent,
    )
    await git(root, 'checkout', 'main')
    expect(await gitText(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
      result: {
        type: 'commit',
        commitId: historical.effectPlan.result.commitId,
        target: { kind: 'detached-head' },
      },
    })
  }, 60_000)

  it('retries a historical detached Commit when its marker disappears before the durability barrier', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const reflogPath = join(root, '.git', 'logs', 'HEAD')
    const retainedPath = `${reflogPath}.retained-marker`
    const markerlessReflog = await readFile(reflogPath)
    const state = { armed: false, markerRead: false, replaced: false, readOpens: 0 }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async lstat(path) {
        if (state.armed && state.markerRead && !state.replaced && path === reflogPath) {
          state.replaced = true
          await rename(reflogPath, retainedPath)
          await writeFile(reflogPath, markerlessReflog)
        }
        return await localGitMutationNodeAdapter.lstat(path)
      },
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (!state.armed || path !== reflogPath || flags !== 'r') return handle
        state.readOpens += 1
        return {
          ...handle,
          async close() {
            await handle.close()
            state.markerRead = true
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'b', 16, 'historical barrier candidate\n', 'historical barrier commit\n',
    )
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        durable = record
        throw new Error('captured historical barrier Commit')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('captured historical barrier Commit')
    persistence.restore()
    if (durable === undefined) throw new Error('test retained no attempted Commit plan')
    const historical = await asHistoricalDetached(durable)
    if (historical.effectPlan?.kind !== 'commit') throw new Error('test retained no detached Commit plan')
    await persistence.original(historical)
    await git(root, 'checkout', '--detach')
    await git(
      root,
      'update-ref', '--no-deref', '--create-reflog', '-m', historical.effectPlan.reflogMarker,
      'HEAD', historical.effectPlan.result.commitId, parent,
    )
    state.armed = true

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'publishing',
    })
    expect(state).toMatchObject({ armed: true, markerRead: true, replaced: true })
    expect(state.readOpens).toBeGreaterThan(0)
    await unlink(reflogPath)
    await rename(retainedPath, reflogPath)
    state.armed = false

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
      result: { type: 'commit', commitId: historical.effectPlan.result.commitId },
    })
  }, 90_000)

  it('cancels a durable not-started Commit without publishing its candidate', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'c', 17, 'cancel candidate\n', 'cancel durable commit\n',
    )
    const persistence = operationPersistence(execution)
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated Commit loss before attempting evidence became durable')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated Commit loss before attempting evidence became durable')
    persistence.restore()

    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'publishing',
    })
    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  }, 60_000)

  it('requires reconciliation when a Commit attempt has no publication witness', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'd', 18, 'reconcile candidate\n', 'reconcile durable commit\n',
    )
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
        && record.effectPlan.publication === 'attempting') {
        durable = record
        throw new Error('simulated Commit loss after attempting evidence became durable')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated Commit loss after attempting evidence became durable')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'commit') throw new Error('test retained no attempted Commit plan')
    const lockPath = join(root, '.git', 'index.lock')
    await link(durable.effectPlan.pin.path, lockPath)

    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'reconciliation-required',
      reason: 'evidence-conflict',
    })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('fails a Commit before effect when repository-local identity is unavailable', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'e', 19, 'identity candidate\n', 'identity unavailable commit\n',
    )
    await git(root, 'config', '--unset', 'user.name')
    await git(root, 'config', '--unset', 'user.email')

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 60_000)

  it('retries a temporary Commit prepublication failure without consuming the operation', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const indexPath = join(root, '.git', 'index')
    const { prepared } = await preparedCommit(
      execution, root, signal, 'f', 20, 'retry candidate\n', 'retry durable commit\n',
    )
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (durable === undefined && record.snapshot.state === 'publishing'
        && record.effectPlan?.kind === 'commit' && record.effectPlan.publication === 'not-started') {
        durable = record
        roots.push(record.effectPlan.scratch.path)
      }
    })
    const runner = mutationRunner(execution)
    let failed = false
    runner.replace(async (...args) => {
      const [, command, , environment] = args
      if (!failed && command[0] === 'write-tree' && environment.objectDirectory === undefined) {
        failed = true
        throw new GitCommandError('spawn-failure')
      }
      return await runner.original(...args)
    })

    const first = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    runner.restore()
    persistence.restore()

    expect(failed).toBe(true)
    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      snapshot: { state: 'publishing' },
    })
    if (durable?.effectPlan?.kind !== 'commit') throw new Error('test retained no retryable Commit plan')
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).resolves.toBeDefined()
    await expect(stat(durable.effectPlan.scratch.path)).resolves.toBeDefined()
    const second = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    expect(second).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    if (!second.ok) throw new Error(`retryable Commit did not complete: ${second.reason}`)
    if (second.snapshot.state !== 'succeeded') throw new Error('retryable Commit retained no result')
    if (second.snapshot.result.type !== 'commit') throw new Error('retryable Commit returned a non-Commit result')
    expect(second.snapshot.result.commitId).not.toBe(parent)
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(second.snapshot.result.commitId)
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 90_000)

  it.each([
    {
      name: 'Stage',
      operation: 'stage-files' as const,
      control: 'update-index' as const,
      payloadDigit: '1',
      admissionRevision: 30,
      expectedProgram: [
        ['hash-object', '-w', '--stdin', '--no-filters'],
        ['update-index', '-z', '--index-info'],
        ['write-tree'],
        ['hash-object', '-w', '--stdin', '--no-filters'],
      ],
    },
    {
      name: 'Unstage',
      operation: 'unstage-files' as const,
      control: 'read-tree' as const,
      payloadDigit: '2',
      admissionRevision: 31,
      expectedProgram: [
        ['update-index', '-z', '--index-info'],
        ['write-tree'],
      ],
    },
  ])('runs only fixed hook-free plumbing while publishing $name', async (scenario) => {
    const root = await repository()
    const controlRoot = await repository()
    const candidate = `${scenario.name} hostile hook candidate\n`
    await writeFile(join(root, 'tracked.txt'), candidate)
    if (scenario.operation === 'unstage-files') {
      await git(root, 'add', '--', 'tracked.txt')
      await writeFile(join(controlRoot, 'tracked.txt'), 'control staged change\n')
      await git(controlRoot, 'add', '--', 'tracked.txt')
    }
    const sentinel = await gitProgramSentinel('saki-index-sentinel-')
    await sentinel.installHooks('post-index-change')
    await git(root, 'config', 'core.hooksPath', sentinel.root)
    await git(controlRoot, 'config', 'core.hooksPath', sentinel.root)

    await rm(sentinel.marker, { force: true })
    if (scenario.control === 'update-index') {
      const objectId = await gitText(controlRoot, 'rev-parse', 'HEAD:tracked.txt')
      await gitTextWithInput(
        controlRoot,
        ['update-index', '-z', '--index-info'],
        Buffer.from(`100644 ${objectId}\tsentinel-control.txt\0`, 'utf8'),
      )
    } else {
      await git(controlRoot, 'read-tree', 'HEAD')
    }
    await expect(readFile(sentinel.marker, 'utf8')).resolves.toContain('post-index-change\n')
    await rm(sentinel.marker, { force: true })

    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hooksPath')
    vi.stubEnv('GIT_CONFIG_VALUE_0', sentinel.root)
    const execution = await provider(root)
    const signal = new AbortController().signal
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const binding = await activeBinding(execution, root, signal)
    const inspected = await execution.inspectProject({ binding }, signal)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') {
      throw new Error(`test repository was not mutable: ${JSON.stringify(inspected)}`)
    }
    const change = inspected.observation.changes.find(candidate => candidate.path === 'tracked.txt')
    if (change === undefined) throw new Error('test repository had no selected change')
    const request: StageFilesHostOperationRequest | UnstageFilesHostOperationRequest = {
      type: scenario.operation,
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: scenario.payloadDigit.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const prepared = await execution.prepareOperation(
      request,
      acceptedAdmission(scenario.admissionRevision),
      signal,
    )
    if (!prepared.ok) throw new Error(`test ${scenario.name} was not prepared: ${prepared.reason}`)
    const mutationProgram: string[][] = []
    const runner = mutationRunner(execution)
    runner.replace(async (...args) => {
      mutationProgram.push([...args[1]])
      return await runner.original(...args)
    })

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    ).finally(() => { runner.restore() })

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: scenario.operation,
          changes: [{ id: change.id, path: 'tracked.txt' }],
        },
      },
    })
    expect(mutationProgram).toEqual(scenario.expectedProgram)
    expect(mutationProgram.some(([subcommand]) => (
      subcommand === 'add' || subcommand === 'commit' || subcommand === 'reset' || subcommand === 'restore'
    ))).toBe(false)
    await expect(readFile(sentinel.marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe(
      scenario.operation === 'stage-files' ? 'tracked.txt' : '',
    )
    expect(await gitText(root, 'diff', '--name-only')).toBe(
      scenario.operation === 'stage-files' ? '' : 'tracked.txt',
    )
    await expect(readFile(join(root, 'tracked.txt'), 'utf8')).resolves.toBe(candidate)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 90_000)

  it('does not execute configured or ambient Git programs while committing', async () => {
    const root = await repository()
    const controlRoot = await repository()
    await writeFile(join(controlRoot, 'tracked.txt'), 'direct Commit control\n')
    await git(controlRoot, 'add', '--', 'tracked.txt')
    const sentinel = await gitProgramSentinel('saki-commit-sentinel-')
    await sentinel.installHooks(
      'reference-transaction',
      'pre-commit',
      'prepare-commit-msg',
      'commit-msg',
      'post-commit',
    )
    for (const repositoryRoot of [root, controlRoot]) {
      for (const [key, value] of [
        ['core.hooksPath', sentinel.root],
        ['commit.gpgSign', 'true'],
        ['gpg.program', sentinel.command('gpg')],
      ] as const) await git(repositoryRoot, 'config', key, value)
    }

    const controlParent = await gitText(controlRoot, 'rev-parse', 'HEAD')
    const controlTree = await gitText(controlRoot, 'write-tree')
    await rm(sentinel.marker, { force: true })
    const unsignedControlCommit = await gitTextWithInput(
      controlRoot,
      ['commit-tree', controlTree, '-p', controlParent, '-F', '-'],
      Buffer.from('production-shaped Commit control\n', 'utf8'),
    )
    await expect(readFile(sentinel.marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await gitText(controlRoot, 'cat-file', '-p', unsignedControlCommit)).not.toMatch(/^gpgsig /mu)
    await git(
      controlRoot,
      'update-ref',
      '--no-deref',
      '--create-reflog',
      '-m',
      'production-shaped reference control',
      'refs/heads/main',
      unsignedControlCommit,
      controlParent,
    )
    await expect(readFile(sentinel.marker, 'utf8')).resolves.toContain('reference-transaction\n')
    await git(
      controlRoot,
      'update-ref',
      '--no-deref',
      '--create-reflog',
      '-m',
      'restore reference control',
      'refs/heads/main',
      controlParent,
      unsignedControlCommit,
    )
    await rm(sentinel.marker, { force: true })

    vi.stubEnv('GIT_AUTHOR_NAME', 'ambient author')
    vi.stubEnv('GIT_COMMITTER_NAME', 'ambient committer')
    vi.stubEnv('GIT_CONFIG_COUNT', '2')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hooksPath')
    vi.stubEnv('GIT_CONFIG_VALUE_0', sentinel.root)
    vi.stubEnv('GIT_CONFIG_KEY_1', 'commit.gpgSign')
    vi.stubEnv('GIT_CONFIG_VALUE_1', 'true')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const message = 'hook-free durable commit\n'
    const { prepared, inspected } = await preparedCommit(
      execution, root, signal, '0', 21, 'hook-free candidate\n', message,
    )
    if (inspected.observation.index.kind !== 'tree') throw new Error('test retained no Commit tree')
    const expectedTree = inspected.observation.index.treeId
    const mutationProgram: string[][] = []
    const runner = mutationRunner(execution)
    runner.replace(async (...args) => {
      mutationProgram.push([...args[1]])
      return await runner.original(...args)
    })

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    ).finally(() => { runner.restore() })

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'commit',
          author: { name: 'Saki Test', email: 'saki@example.invalid' },
          committer: { name: 'Saki Test', email: 'saki@example.invalid' },
        },
      },
    })
    if (!started.ok) throw new Error(`test Commit was unavailable: ${started.reason}`)
    if (started.snapshot.state !== 'succeeded') throw new Error('test Commit did not succeed')
    if (started.snapshot.result.type !== 'commit') throw new Error('test Commit returned another result kind')
    const commitId = started.snapshot.result.commitId
    expect(mutationProgram).toEqual([
      ['var', 'GIT_AUTHOR_IDENT'],
      ['write-tree'],
      ['commit-tree', expectedTree, '-p', parent, '-F', '-'],
      ['write-tree'],
      ['commit-tree', expectedTree, '-p', parent, '-F', '-'],
      [
        'update-ref',
        '--no-deref',
        '--create-reflog',
        '-m',
        `saki host-operation ${prepared.preparation.operation.id}`,
        'refs/heads/main',
        commitId,
        parent,
      ],
    ])
    expect(mutationProgram.some(([subcommand]) => subcommand === 'commit')).toBe(false)
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(commitId)
    expect(await gitText(root, 'show', '-s', '--format=%an <%ae>', commitId)).toBe(
      'Saki Test <saki@example.invalid>',
    )
    expect(await gitText(root, 'show', '-s', '--format=%cn <%ce>', commitId)).toBe(
      'Saki Test <saki@example.invalid>',
    )
    expect(await gitText(root, 'show', '-s', '--format=%B', commitId)).toBe(message.trim())
    expect(await gitText(root, 'cat-file', '-p', commitId)).not.toMatch(/^gpgsig /mu)
    expect(await gitText(root, 'status', '--porcelain=v1')).toBe('')
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(sentinel.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 90_000)

  it('cleans an undurable index pin after a file-sync failure and remains retryable', async () => {
    const root = await repository()
    const failure = Object.assign(new Error('injected index pin sync failure'), { code: 'EIO' })
    let pinPath: string | undefined
    let injected = false
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (flags !== 'wx' || !path.endsWith('.pin')) return handle
        pinPath = path
        return {
          ...handle,
          async sync() {
            if (!injected) {
              injected = true
              throw failure
            }
            await handle.sync()
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const originalGitEntries = (await readdir(join(root, '.git'))).sort()

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toBe(failure)

    expect(pinPath).toBeDefined()
    await expect(stat(pinPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(indexPath)).toEqual(originalIndex)
    expect((await readdir(join(root, '.git'))).sort()).toEqual(originalGitEntries)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'planning',
      revision: 2,
    })

    const retried = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    expect(retried).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 60_000)

  it('discards an undurable Stage plan when cancellation arrives after its pin sync', async () => {
    const root = await repository()
    const controller = new AbortController()
    const reason = new Error('cancel after Stage pin sync')
    let pinPath: string | undefined
    let scratchPath: string | undefined
    let injected = false
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async lstat(path) {
        const info = await localGitMutationNodeAdapter.lstat(path)
        if (scratchPath === undefined && path.startsWith(join(tmpdir(), 'saki-host-operation-'))
          && !path.includes('.cleanup-') && info.isDirectory()) scratchPath = path
        return info
      },
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (flags !== 'wx' || !path.endsWith('.pin')) return handle
        pinPath = path
        return {
          ...handle,
          async sync() {
            await handle.sync()
            if (!injected) {
              injected = true
              controller.abort(reason)
            }
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const { prepared } = await preparedStage(execution, root, controller.signal, '6', 11)
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      controller.signal,
    )).rejects.toBe(reason)

    expect(injected).toBe(true)
    expect(pinPath).toBeDefined()
    expect(scratchPath).toBeDefined()
    await expect(stat(pinPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    const freshSignal = new AbortController().signal
    expect(await execution.inspectOperation(
      prepared.preparation.operation,
      freshSignal,
    )).toMatchObject({ state: 'planning', revision: 2 })
    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      freshSignal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
  }, 75_000)

  it('maps a non-collision exclusive pin-open failure to a retryable unavailable start', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const failure = Object.assign(new Error('injected exclusive pin open failure'), { code: 'EIO' })
    let injected = false
    let attemptedPinPath: string | undefined
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        if (!injected && flags === 'wx' && path.endsWith('.pin')) {
          injected = true
          attemptedPinPath = path
          throw failure
        }
        return await localGitMutationNodeAdapter.open(path, flags, mode)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const originalEntries = (await readdir(join(root, '.git'))).sort()

    const first = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(injected).toBe(true)
    expect(attemptedPinPath).toBeDefined()
    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      snapshot: { state: 'planning', revision: 2 },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(attemptedPinPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(join(root, '.git'))).sort()).toEqual(originalEntries)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 60_000)

  it('preserves a foreign replacement when cleaning a failed index pin write', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const failure = Object.assign(new Error('injected pin sync failure before identity cleanup'), { code: 'EIO' })
    const foreignBytes = Buffer.from('foreign pin replacement\n')
    let injected = false
    let failedPinPath: string | undefined
    let retainedOriginalPinPath: string | undefined
    let retryPinPath: string | undefined
    let originalIdentity: { readonly device: string; readonly inode: string } | undefined
    let foreignIdentity: { readonly device: string; readonly inode: string } | undefined
    let replaced = false
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (flags !== 'wx' || !path.endsWith('.pin')) return handle
        if (injected) {
          retryPinPath = path
          return handle
        }
        failedPinPath = path
        const info = await handle.stat()
        originalIdentity = { device: info.dev.toString(), inode: info.ino.toString() }
        return {
          ...handle,
          async sync() {
            if (!injected) {
              injected = true
              throw failure
            }
            await handle.sync()
          },
        }
      },
      async lstat(path) {
        if (injected && !replaced && path === failedPinPath) {
          replaced = true
          retainedOriginalPinPath = `${path}.retained-original`
          await localGitMutationNodeAdapter.rename(path, retainedOriginalPinPath)
          await writeFile(path, foreignBytes, { flag: 'wx' })
          const info = await localGitMutationNodeAdapter.lstat(path)
          foreignIdentity = { device: info.dev.toString(), inode: info.ino.toString() }
        }
        return await localGitMutationNodeAdapter.lstat(path)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toBe(failure)

    expect(replaced).toBe(true)
    expect(failedPinPath).toBeDefined()
    expect(originalIdentity).toBeDefined()
    expect(foreignIdentity).toBeDefined()
    expect(foreignIdentity).not.toEqual(originalIdentity)
    await expect(stat(retainedOriginalPinPath as string)).resolves.toBeDefined()
    await expect(readFile(failedPinPath as string)).resolves.toEqual(foreignBytes)
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'planning',
      revision: 2,
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(retryPinPath).toBeDefined()
    await expect(readFile(failedPinPath as string)).resolves.toEqual(foreignBytes)
    const retained = await localGitMutationNodeAdapter.lstat(failedPinPath as string)
    expect({ device: retained.dev.toString(), inode: retained.ino.toString() }).toEqual(foreignIdentity)
    await expect(stat(retryPinPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 60_000)

  it('cleans a scratch directory when its owner opens on a different device', async () => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const state = {
      injecting: true,
      injected: false,
      removed: false,
      scratchPath: undefined as string | undefined,
    }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async lstat(path) {
        const actual = await localGitMutationNodeAdapter.lstat(path)
        if (!state.injecting || !actual.isDirectory()
          || !basename(path).startsWith('saki-host-operation-')) return actual
        if (state.scratchPath === undefined) {
          state.scratchPath = path
          roots.push(path)
        }
        Object.defineProperty(actual, 'dev', {
          value: actual.dev + 1n,
          enumerable: true,
          configurable: true,
        })
        return actual
      },
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (flags !== 'wx' || basename(path) !== 'owner'
          || dirname(path) !== state.scratchPath) return handle
        return {
          ...handle,
          async stat() {
            const info = await handle.stat()
            state.injected = true
            return info
          },
        }
      },
      async rmdir(path) {
        await localGitMutationNodeAdapter.rmdir(path)
        if (path === state.scratchPath) {
          state.removed = true
          state.injecting = false
        }
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)

    const first = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(state.injected).toBe(true)
    expect(state.removed).toBe(true)
    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      snapshot: { state: 'planning', revision: 2 },
    })
    expect(state.scratchPath).toBeDefined()
    await expect(stat(state.scratchPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 75_000)

  it('cleans an index pin when its opened file is on a different device than its admitted directory', async () => {
    const root = await repository()
    const pinDirectory = join(root, '.git')
    let injected = false
    let pinPath: string | undefined
    let pinHandle: Awaited<ReturnType<LocalGitMutationNodeAdapter['open']>> | undefined
    let openedIdentity: { readonly device: string; readonly inode: string } | undefined
    let removedIdentity: { readonly device: string; readonly inode: string } | undefined
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async lstat(path) {
        const actual = await localGitMutationNodeAdapter.lstat(path)
        if (injected || path !== pinDirectory) return actual
        injected = true
        Object.defineProperty(actual, 'dev', {
          value: actual.dev + 1n,
          enumerable: true,
          configurable: true,
        })
        return actual
      },
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (flags !== 'wx' || !path.endsWith('.pin')) return handle
        pinPath = path
        pinHandle = handle
        const info = await handle.stat()
        openedIdentity = { device: info.dev.toString(), inode: info.ino.toString() }
        return handle
      },
      async rm(path, options) {
        if (path === pinPath) {
          const info = await localGitMutationNodeAdapter.lstat(path)
          removedIdentity = { device: info.dev.toString(), inode: info.ino.toString() }
        }
        await localGitMutationNodeAdapter.rm(path, options)
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)

    const first = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(injected).toBe(true)
    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      snapshot: { state: 'planning', revision: 2 },
    })
    expect(pinPath).toBeDefined()
    expect(pinHandle).toBeDefined()
    expect(removedIdentity).toEqual(openedIdentity)
    await expect(pinHandle?.stat()).rejects.toThrow()
    await expect(stat(pinPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 60_000)

  it.each([
    { name: 'keeps the owned-file result', abortOnClose: false },
    { name: 'preserves abort priority', abortOnClose: true },
  ] as const)('ignores an owned-file handle close rejection and $name', async ({ abortOnClose }) => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const controller = new AbortController()
    const abortReason = new Error('owned-file close abort wins')
    const closeFailure = new Error('injected owned-file close rejection')
    const state = {
      enabled: true,
      closeCalls: 0,
      pinPath: undefined as string | undefined,
      scratchPath: undefined as string | undefined,
    }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (flags === 'wx' && basename(path) === 'owner'
          && basename(dirname(path)).startsWith('saki-host-operation-')) {
          const scratchPath = dirname(path)
          state.scratchPath = scratchPath
          roots.push(scratchPath)
        } else if (flags === 'wx' && path.endsWith('.pin')) {
          state.pinPath = path
        }
        if (!state.enabled || flags !== 'r' || path !== state.pinPath) return handle
        return {
          ...handle,
          async close() {
            state.closeCalls += 1
            await handle.close()
            if (abortOnClose) controller.abort(abortReason)
            throw closeFailure
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const { prepared } = await preparedStage(
      execution,
      root,
      controller.signal,
      abortOnClose ? '8' : '7',
      abortOnClose ? 29 : 28,
    )

    if (abortOnClose) {
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        controller.signal,
      )).rejects.toBe(abortReason)
      state.enabled = false
      await expect(execution.inspectOperation(
        prepared.preparation.operation,
        new AbortController().signal,
      )).resolves.toMatchObject({ state: 'publishing' })
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(state.pinPath as string)).resolves.toBeDefined()
      await expect(stat(state.scratchPath as string)).resolves.toBeDefined()
    } else {
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        controller.signal,
      )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(state.pinPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(state.scratchPath as string)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(state.closeCalls).toBeGreaterThan(0)
    expect(state.pinPath).toBeDefined()
    expect(state.scratchPath).toBeDefined()
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 90_000)

  it('honors an abort raised while closing final false-result owned-file evidence', async () => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)
    const controller = new AbortController()
    const abortReason = new Error('final owned-file close abort wins')
    const closeFailure = new Error('injected final owned-file close rejection')
    const state = { armed: false, pinPath: undefined as string | undefined, read: false, closed: false }
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (!state.armed || path !== state.pinPath || flags !== 'r') return handle
        return {
          ...handle,
          async read() {
            state.read = true
            return { bytesRead: 0 }
          },
          async close() {
            await handle.close()
            state.closed = true
            controller.abort(abortReason)
            throw closeFailure
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const { prepared, durable } = await captureDurableNotStartedStage(
      execution,
      root,
      controller.signal,
      '9',
      30,
    )
    if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    state.pinPath = durable.effectPlan.pin.path
    state.armed = true

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      controller.signal,
    )).rejects.toBe(abortReason)

    expect(state.read).toBe(true)
    expect(state.closed).toBe(true)
    await expect(execution.inspectOperation(
      prepared.preparation.operation,
      new AbortController().signal,
    )).resolves.toMatchObject({ state: 'publishing' })
    await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    await expect(stat(durable.effectPlan.pin.path)).resolves.toBeDefined()
    await expect(stat(durable.effectPlan.scratch.path)).resolves.toBeDefined()
    await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 90_000)

  it('closes an unclassified index pin when its first metadata read fails', async () => {
    const root = await repository()
    const failure = Object.assign(new Error('injected initial pin stat failure'), { code: 'EIO' })
    let pinPath: string | undefined
    let pinHandle: Awaited<ReturnType<LocalGitMutationNodeAdapter['open']>> | undefined
    let injected = false
    const node: LocalGitMutationNodeAdapter = {
      ...localGitMutationNodeAdapter,
      async open(path, flags, mode) {
        const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
        if (flags !== 'wx' || !path.endsWith('.pin')) return handle
        pinPath ??= path
        pinHandle ??= handle
        return {
          ...handle,
          async stat() {
            if (!injected) {
              injected = true
              await handle.stat()
              throw failure
            }
            return await handle.stat()
          },
        }
      },
    }
    const execution = await provider(root, { node })
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const indexPath = join(root, '.git', 'index')
    const originalIndex = await readFile(indexPath)

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toBe(failure)

    expect(pinPath).toBeDefined()
    expect(pinHandle).toBeDefined()
    let handleClosed = false
    try {
      await pinHandle?.stat()
    } catch {
      handleClosed = true
    }
    if (!handleClosed) await pinHandle?.close()
    expect(handleClosed).toBe(true)
    expect(await stat(pinPath as string)).toMatchObject({ size: 0 })
    expect(await readFile(indexPath)).toEqual(originalIndex)
    expect((await readdir(join(root, '.git'))).filter(name => name === 'index.lock')).toEqual([])
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'planning',
      revision: 2,
    })

    const retried = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    expect(retried).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await stat(pinPath as string)).toMatchObject({ size: 0 })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 60_000)

  describe('Stage cancel index evidence failure boundaries', () => {
    it('preserves caller abort after recovery closes the first real index read', async () => {
      await expectStageCancelIndexEvidenceFailure('abort', '1', 55)
    }, 120_000)

    it('keeps publishing when cancel index evidence has a real EIO', async () => {
      await expectStageCancelIndexEvidenceFailure('retryable', '2', 56)
    }, 120_000)

    it('keeps publishing when cancel index evidence is a real directory', async () => {
      await expectStageCancelIndexEvidenceFailure('no-effect', '3', 57)
    }, 120_000)

    it('throws an unexpected cancel index evidence failure without consuming publication', async () => {
      await expectStageCancelIndexEvidenceFailure('unexpected', '4', 58)
    }, 120_000)
  })

  describe('Commit recovery and cancel target failure boundaries', () => {
    it('throws a plain failure from the first exact Commit recovery target read', async () => {
      const root = await repository()
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedCommit(
        execution,
        root,
        signal,
        '5',
        59,
        'first recovery target failure\n',
        'first recovery target failure\n',
      )
      if (durable.effectPlan?.kind !== 'commit' || durable.request.type !== 'commit') {
        throw new Error('test retained no durable Commit plan')
      }
      const plan = durable.effectPlan
      const indexPath = join(
        durable.request.expected.binding.expectedInspection.trusted.canonicalGitDirectory,
        'index',
      )
      const worktreePath = durable.request.expected.binding.expectedInspection.trusted.canonicalWorktreePath
      const lockPath = `${indexPath}.lock`
      const targetCommand = ['rev-parse', '--verify', '--end-of-options', plan.targetRef]
      const quarantinePath = `${plan.scratch.path}.cleanup-${plan.scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      for (const path of [plan.scratch.path, quarantinePath, witnessPath]) {
        if (!roots.includes(path)) roots.push(path)
      }
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const stagedTree = await gitText(root, 'write-tree')
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      expect(await gitText(root, 'diff', '--name-only')).toBe('')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const pinBytes = await readFile(plan.pin.path)
      const pinInfo = await stat(plan.pin.path, { bigint: true })
      const scratchInfo = await stat(plan.scratch.path, { bigint: true })
      const scratchOwner = await readFile(join(plan.scratch.path, 'owner'))
      const sentinel = new Error('injected first Commit recovery target failure')
      const state = { exactTargetReads: 0, injected: false, persistCalls: 0, updateRefCalls: 0 }
      const persistence = operationPersistence(execution)
      persistence.replace(async (record) => {
        state.persistCalls += 1
        await persistence.original(record)
      })
      const runner = mutationRunner(execution)
      runner.replaceRun(async (...args) => {
        const [cwd, command] = args
        if (cwd === worktreePath && command.length === targetCommand.length
          && command.every((value, index) => value === targetCommand[index])) {
          state.exactTargetReads += 1
          state.injected = true
          throw sentinel
        }
        return await runner.originalRun(...args)
      })
      runner.replace(async (...args) => {
        const [, command] = args
        if (command[0] === 'update-ref') state.updateRefCalls += 1
        return await runner.original(...args)
      })

      try {
        await expect(execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).rejects.toBe(sentinel)
      } finally {
        persistence.restore()
        runner.restore()
      }

      expect(state).toEqual({ exactTargetReads: 1, injected: true, persistCalls: 0, updateRefCalls: 0 })
      expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
        state: 'publishing',
        revision: durable.snapshot.revision,
      })
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      const finalIndexInfo = await stat(indexPath, { bigint: true })
      expect({
        device: finalIndexInfo.dev.toString(),
        inode: finalIndexInfo.ino.toString(),
        mode: Number(finalIndexInfo.mode & 0o777n),
      }).toEqual({
        device: originalIndexInfo.dev.toString(),
        inode: originalIndexInfo.ino.toString(),
        mode: Number(originalIndexInfo.mode & 0o777n),
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(root, 'write-tree')).toBe(stagedTree)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      expect(await gitText(root, 'diff', '--name-only')).toBe('')
      const finalPinInfo = await stat(plan.pin.path, { bigint: true })
      expect({
        device: finalPinInfo.dev.toString(),
        inode: finalPinInfo.ino.toString(),
        mode: Number(finalPinInfo.mode & 0o777n),
      }).toEqual({
        device: pinInfo.dev.toString(),
        inode: pinInfo.ino.toString(),
        mode: Number(pinInfo.mode & 0o777n),
      })
      await expect(readFile(plan.pin.path)).resolves.toEqual(pinBytes)
      expect(pinBytes.byteLength).toBe(plan.pin.byteLength)
      expect(createHash('sha256').update(pinBytes).digest('hex')).toBe(plan.pin.digest)
      const finalScratchInfo = await stat(plan.scratch.path, { bigint: true })
      expect({
        device: finalScratchInfo.dev.toString(),
        inode: finalScratchInfo.ino.toString(),
        mode: Number(finalScratchInfo.mode & 0o777n),
      }).toEqual({
        device: scratchInfo.dev.toString(),
        inode: scratchInfo.ino.toString(),
        mode: Number(scratchInfo.mode & 0o777n),
      })
      await expect(readFile(join(plan.scratch.path, 'owner'))).resolves.toEqual(scratchOwner)
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        new AbortController().signal,
      )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded', result: { type: 'commit' } } })
      expect(await gitText(root, 'rev-parse', 'HEAD')).not.toBe(parent)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it('preserves caller abort from the second exact Commit cancel target read', async () => {
      await expectCommitCancelTargetFailure('abort', '6', 60)
    }, 120_000)

    it('throws a plain failure from the second exact Commit cancel target read', async () => {
      await expectCommitCancelTargetFailure('unexpected', '7', 61)
    }, 120_000)

    it('keeps a Commit planning after a non-missing worktree identity failure', async () => {
      const root = await repository()
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const scratchPaths: string[] = []
      const scratchCleanupPaths: string[] = []
      const state = {
        failurePhase: true,
        ownerCreates: 0,
        ownerCloses: 0,
        pinCreates: 0,
        lockLinks: 0,
        indexPublications: 0,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async open(path, flags, mode) {
          const scratchPath = flags === 'wx' && basename(path) === 'owner'
            && isTestOperationScratchWrapper(dirname(path))
            ? dirname(path)
            : undefined
          if (scratchPath !== undefined && !roots.includes(scratchPath)) roots.push(scratchPath)
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (scratchPath !== undefined) {
            scratchPaths.push(scratchPath)
            if (state.failurePhase) state.ownerCreates += 1
            return {
              ...handle,
              async close() {
                await handle.close()
                if (state.failurePhase) state.ownerCloses += 1
                const owner = await readFile(path)
                const markerDigest = createHash('sha256').update(owner).digest('hex')
                const quarantinePath = `${scratchPath}.cleanup-${markerDigest.slice(0, 32)}`
                const witnessPath = `${quarantinePath}.owner`
                scratchCleanupPaths.push(quarantinePath, witnessPath)
                for (const cleanupPath of [quarantinePath, witnessPath]) {
                  if (!roots.includes(cleanupPath)) roots.push(cleanupPath)
                }
              },
            }
          }
          if (state.failurePhase && flags === 'wx' && path.endsWith('.pin')) state.pinCreates += 1
          return handle
        },
        async link(from, to) {
          if (state.failurePhase) state.lockLinks += 1
          await localGitMutationNodeAdapter.link(from, to)
        },
        async rename(from, to) {
          if (state.failurePhase && basename(from) === 'index.lock' && basename(to) === 'index') {
            state.indexPublications += 1
          }
          await localGitMutationNodeAdapter.rename(from, to)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, request } = await preparedCommit(
        execution,
        root,
        signal,
        '8',
        62,
        'non-missing identity failure\n',
        'non-missing identity failure\n',
      )
      const worktreePath = request.expected.binding.expectedInspection.trusted.canonicalWorktreePath
      const indexPath = join(
        request.expected.binding.expectedInspection.trusted.canonicalGitDirectory,
        'index',
      )
      const lockPath = `${indexPath}.lock`
      const stagedTree = await gitText(root, 'write-tree')
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      expect(await gitText(root, 'diff', '--name-only')).toBe('')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const configFailure = new GitCommandError('nonzero', 2)
      expect({ code: configFailure.code, exitCode: configFailure.exitCode }).toEqual({
        code: 'nonzero',
        exitCode: 2,
      })
      const commands = {
        worktreeName: 0,
        localName: 0,
        email: 0,
        commitTree: 0,
        updateRef: 0,
      }
      const persistedStates: LocalHostOperationRecord['snapshot']['state'][] = []
      const persistence = operationPersistence(execution)
      persistence.replace(async (record) => {
        persistedStates.push(record.snapshot.state)
        await persistence.original(record)
      })
      const runner = mutationRunner(execution)
      runner.replaceRun(async (...args) => {
        const [cwd, command] = args
        const exactWorktreeName = cwd === worktreePath && command.length === 5
          && command[0] === 'config' && command[1] === '--no-includes'
          && command[2] === '--worktree' && command[3] === '--get' && command[4] === 'user.name'
        if (exactWorktreeName) {
          commands.worktreeName += 1
          throw configFailure
        }
        if (cwd === worktreePath && command[0] === 'config' && command[2] === '--local'
          && command[4] === 'user.name') commands.localName += 1
        if (cwd === worktreePath && command[0] === 'config' && command[4] === 'user.email') {
          commands.email += 1
        }
        return await runner.originalRun(...args)
      })
      runner.replace(async (...args) => {
        const [, command] = args
        if (command[0] === 'commit-tree') commands.commitTree += 1
        if (command[0] === 'update-ref') commands.updateRef += 1
        return await runner.original(...args)
      })

      let started: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>>
      try {
        started = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } finally {
        persistence.restore()
        runner.restore()
      }

      expect(started).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'planning', revision: 2 },
      })
      expect(persistedStates).toEqual(['accepted', 'planning'])
      expect(commands).toEqual({ worktreeName: 1, localName: 0, email: 0, commitTree: 0, updateRef: 0 })
      expect(state).toEqual({
        failurePhase: true,
        ownerCreates: 1,
        ownerCloses: 1,
        pinCreates: 0,
        lockLinks: 0,
        indexPublications: 0,
      })
      expect(scratchPaths).toHaveLength(1)
      expect(scratchCleanupPaths).toHaveLength(2)
      for (const path of [...scratchPaths, ...scratchCleanupPaths]) {
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      const finalIndexInfo = await stat(indexPath, { bigint: true })
      expect({
        device: finalIndexInfo.dev.toString(),
        inode: finalIndexInfo.ino.toString(),
        mode: Number(finalIndexInfo.mode & 0o777n),
      }).toEqual({
        device: originalIndexInfo.dev.toString(),
        inode: originalIndexInfo.ino.toString(),
        mode: Number(originalIndexInfo.mode & 0o777n),
      })
      expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
        state: 'planning',
        revision: 2,
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(root, 'write-tree')).toBe(stagedTree)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      expect(await gitText(root, 'diff', '--name-only')).toBe('')

      state.failurePhase = false
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        new AbortController().signal,
      )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded', result: { type: 'commit' } } })
      expect(await gitText(root, 'rev-parse', 'HEAD')).not.toBe(parent)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      for (const path of [...scratchPaths, ...scratchCleanupPaths]) {
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)
  })

  describe('stable mutation observation boundaries', () => {
    it('rejects Stage in a genuinely locked linked worktree before creating resources', async () => {
      const root = await repository()
      const linked = `${root}-locked-stage`
      roots.push(linked)
      await git(root, 'config', 'core.autocrlf', 'false')
      await git(root, 'worktree', 'add', '-b', 'locked-stage', linked)
      await git(root, 'worktree', 'lock', linked)
      const expectedPaths: { index?: string; lock?: string } = {}
      const createdPinPaths = new Set<string>()
      const resources = {
        ownerCreates: 0,
        ownerCloses: 0,
        pinCreates: 0,
        pinLinks: 0,
        indexPublications: 0,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async open(path, flags, mode) {
          const scratchPath = flags === 'wx' && basename(path) === 'owner'
            && isTestOperationScratchWrapper(dirname(path))
            ? dirname(path)
            : undefined
          if (scratchPath !== undefined && !roots.includes(scratchPath)) roots.push(scratchPath)
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (scratchPath !== undefined) {
            resources.ownerCreates += 1
            return {
              ...handle,
              async close() {
                await handle.close()
                resources.ownerCloses += 1
                const owner = await readFile(path)
                const markerDigest = createHash('sha256').update(owner).digest('hex')
                const quarantinePath = `${scratchPath}.cleanup-${markerDigest.slice(0, 32)}`
                const witnessPath = `${quarantinePath}.owner`
                for (const cleanupPath of [quarantinePath, witnessPath]) {
                  if (!roots.includes(cleanupPath)) roots.push(cleanupPath)
                }
              },
            }
          }
          if (flags === 'wx' && path.endsWith('.pin')) {
            resources.pinCreates += 1
            createdPinPaths.add(path)
          }
          return handle
        },
        async link(from, to) {
          if (expectedPaths.lock !== undefined && to === expectedPaths.lock && createdPinPaths.has(from)) {
            resources.pinLinks += 1
          }
          await localGitMutationNodeAdapter.link(from, to)
        },
        async rename(from, to) {
          if (expectedPaths.index !== undefined && expectedPaths.lock !== undefined
            && from === expectedPaths.lock && to === expectedPaths.index) {
            resources.indexPublications += 1
          }
          await localGitMutationNodeAdapter.rename(from, to)
        },
      }
      const execution = await provider(linked, { node })
      const signal = new AbortController().signal
      const selected = await execution.inspectProjectSelection(
        { hostId: HOST_ID, directoryLocator: linked },
        signal,
      )
      expect(selected).toMatchObject({
        ok: true,
        inspection: {
          projection: {
            locked: true,
            inheritedChangeEntryCount: 0,
            conversionAmbiguous: false,
            automaticMutationEligible: false,
            blockingReasons: ['locked'],
            baseline: { kind: 'complete', entries: [] },
          },
        },
      })
      if (!selected.ok) throw new Error('test locked worktree was not selectable')
      const binding: ActiveHostProjectBinding = {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      }
      const worktreePath = join(linked, 'tracked.txt')
      const changedContents = 'locked linked worktree change\n'
      await writeFile(worktreePath, changedContents)
      const inspected = await execution.inspectProject({ binding }, signal)
      if (!inspected.ok) throw new Error(`test locked change was not inspectable: ${inspected.reason}`)
      expect(inspected.observation).toMatchObject({
        locked: true,
        structuredMutation: { available: false, blockers: ['locked'] },
      })
      const change = inspected.observation.changes.find(candidate => candidate.path === 'tracked.txt')
      if (change === undefined) throw new Error('test locked inspection exposed no changed path')
      const prepared = await prepareStageSelection(
        execution,
        binding,
        inspected,
        [{ id: change.id, fingerprint: change.fingerprint }],
        signal,
        '9',
      )
      const adminDirectory = await gitText(linked, 'rev-parse', '--absolute-git-dir')
      const indexPath = join(adminDirectory, 'index')
      const lockPath = `${indexPath}.lock`
      expectedPaths.index = indexPath
      expectedPaths.lock = lockPath
      const parent = await gitText(linked, 'rev-parse', 'HEAD')
      const indexTree = await gitText(linked, 'write-tree')
      expect(await gitText(linked, 'diff', '--cached', '--name-only')).toBe('')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const started = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )

      expect(started).toMatchObject({
        ok: true,
        snapshot: {
          state: 'failed',
          failure: { reason: 'unsupported-state' },
          effect: 'none',
        },
      })
      expect(liveOperationCount(execution)).toBe(0)
      expect(resources).toEqual({
        ownerCreates: 0,
        ownerCloses: 0,
        pinCreates: 0,
        pinLinks: 0,
        indexPublications: 0,
      })
      expect((await stat(join(linked, '.git'))).isFile()).toBe(true)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      const finalIndexInfo = await stat(indexPath, { bigint: true })
      expect({
        device: finalIndexInfo.dev.toString(),
        inode: finalIndexInfo.ino.toString(),
        mode: Number(finalIndexInfo.mode & 0o777n),
      }).toEqual({
        device: originalIndexInfo.dev.toString(),
        inode: originalIndexInfo.ino.toString(),
        mode: Number(originalIndexInfo.mode & 0o777n),
      })
      expect(await gitText(linked, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(linked, 'write-tree')).toBe(indexTree)
      expect(await gitText(linked, 'diff', '--cached', '--name-only')).toBe('')
      await expect(readFile(worktreePath, 'utf8')).resolves.toBe(changedContents)
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(adminDirectory)).filter(name => name.includes(
        prepared.preparation.operation.id,
      ) && name.endsWith('.pin'))).toEqual([])
      const worktrees = await gitText(root, 'worktree', 'list', '--porcelain')
      const lockedBlock = worktrees.split(/\r?\n\r?\n/u).find(block => block.includes('branch refs/heads/locked-stage'))
      expect(lockedBlock?.split(/\r?\n/u)).toContain('locked')
    }, 90_000)

    it('rejects a same-length regular-file drift after the final stable observation', async () => {
      const root = await repository()
      const remoteUrl = 'https://example.invalid/stable-byte-drift.git'
      await git(root, 'remote', 'add', 'origin', remoteUrl)
      const exactPaths: { worktree?: string } = {}
      let materializeReadArmed = false
      const materializeRead = { opens: 0, readCalls: 0, bytesRead: 0, closes: 0 }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async open(path, flags, mode) {
          const scratchPath = flags === 'wx' && basename(path) === 'owner'
            && isTestOperationScratchWrapper(dirname(path))
            ? dirname(path)
            : undefined
          if (scratchPath !== undefined && !roots.includes(scratchPath)) roots.push(scratchPath)
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (scratchPath !== undefined) {
            return {
              ...handle,
              async close() {
                await handle.close()
                const owner = await readFile(path)
                const markerDigest = createHash('sha256').update(owner).digest('hex')
                const quarantinePath = `${scratchPath}.cleanup-${markerDigest.slice(0, 32)}`
                const witnessPath = `${quarantinePath}.owner`
                for (const cleanupPath of [quarantinePath, witnessPath]) {
                  if (!roots.includes(cleanupPath)) roots.push(cleanupPath)
                }
              },
            }
          }
          if (!materializeReadArmed || exactPaths.worktree === undefined
            || path !== exactPaths.worktree || flags !== 'r') return handle
          materializeRead.opens += 1
          return {
            ...handle,
            async read(buffer, offset, length, position) {
              const result = await handle.read(buffer, offset, length, position)
              materializeRead.readCalls += 1
              materializeRead.bytesRead += result.bytesRead
              return result
            },
            async close() {
              await handle.close()
              materializeRead.closes += 1
            },
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const binding = await activeBinding(execution, root, signal)
      const worktreeRoot = binding.expectedInspection.trusted.canonicalWorktreePath
      const worktreePath = join(worktreeRoot, 'tracked.txt')
      exactPaths.worktree = worktreePath
      const selectedBytes = Buffer.from('same-length selected bytes\n')
      await writeFile(worktreePath, selectedBytes)
      const inspected = await execution.inspectProject({ binding }, signal)
      if (!inspected.ok) throw new Error(`test selected bytes were not inspectable: ${inspected.reason}`)
      const change = inspected.observation.changes.find(candidate => candidate.path === 'tracked.txt')
      if (change === undefined) throw new Error('test inspection exposed no selected regular file')
      const prepared = await prepareStageSelection(
        execution,
        binding,
        inspected,
        [{ id: change.id, fingerprint: change.fingerprint }],
        signal,
        'a',
      )
      const indexPath = join(binding.expectedInspection.trusted.canonicalGitDirectory, 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const indexTree = await gitText(root, 'write-tree')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const selectedObjectId = await gitTextWithInput(
        root,
        ['hash-object', '--stdin', '--no-filters'],
        selectedBytes,
      )
      await expect(run('git', ['cat-file', '-e', selectedObjectId], {
        cwd: root,
        windowsHide: true,
      })).rejects.toBeDefined()

      const persistence = operationPersistence(execution)
      const runner = mutationRunner(execution)
      let durableArmed = false
      let durable: LocalHostOperationRecord | undefined
      let registeredScratchPath: string | undefined
      const finalStatusViews: string[] = []
      let postDurableObjectWrites = 0
      let driftEvidence: {
        readonly before: Buffer
        readonly after: Buffer
        readonly beforeIdentity: { readonly device: string; readonly inode: string; readonly size: string }
        readonly afterIdentity: { readonly device: string; readonly inode: string; readonly size: string }
      } | undefined
      persistence.replace(async (record) => {
        if (registeredScratchPath === undefined && record.effectPlan?.kind === 'index') {
          registeredScratchPath = record.effectPlan.scratch.path
          if (!isTestOperationScratchWrapper(registeredScratchPath)) {
            throw new Error('test observed a Stage scratch outside the owned temporary range')
          }
          const quarantinePath = `${registeredScratchPath}.cleanup-${record.effectPlan.scratch.markerDigest.slice(0, 32)}`
          const witnessPath = `${quarantinePath}.owner`
          for (const path of [registeredScratchPath, quarantinePath, witnessPath]) {
            if (!roots.includes(path)) roots.push(path)
          }
        }
        await persistence.original(record)
        if (!durableArmed && record.snapshot.state === 'publishing'
          && record.effectPlan?.kind === 'index' && record.effectPlan.publication === 'not-started') {
          durable = record
          durableArmed = true
        }
      })
      runner.replaceRun(async (...args) => {
        const [cwd, command] = args
        const exactFinalStatusWrite = durableArmed
          && command.length === 3
          && command[0] === `--git-dir=${cwd}`
          && command[1] === `--work-tree=${worktreeRoot}`
          && command[2] === 'write-tree'
        if (!exactFinalStatusWrite) return await runner.originalRun(...args)
        expect(dirname(cwd)).toBe(tmpdir())
        expect(basename(cwd)).toMatch(/^saki-git-view-/u)
        if (!roots.includes(cwd)) roots.push(cwd)
        const output = await runner.originalRun(...args)
        expect(output.stderr.byteLength).toBe(0)
        expect(output.stdout.toString('utf8')).toMatch(new RegExp(`^${indexTree}\\r?\\n$`, 'u'))
        expect(finalStatusViews).not.toContain(cwd)
        finalStatusViews.push(cwd)
        if (finalStatusViews.length === 2) {
          const before = await readFile(worktreePath)
          const beforeInfo = await stat(worktreePath, { bigint: true })
          const after = Buffer.from(before)
          after[after.byteLength - 1] = after[after.byteLength - 1] === 0x21 ? 0x3f : 0x21
          await writeFile(worktreePath, after)
          const afterInfo = await stat(worktreePath, { bigint: true })
          materializeReadArmed = true
          driftEvidence = {
            before,
            after,
            beforeIdentity: {
              device: beforeInfo.dev.toString(),
              inode: beforeInfo.ino.toString(),
              size: beforeInfo.size.toString(),
            },
            afterIdentity: {
              device: afterInfo.dev.toString(),
              inode: afterInfo.ino.toString(),
              size: afterInfo.size.toString(),
            },
          }
        }
        return output
      })
      runner.replace(async (...args) => {
        const [cwd, command, , environment] = args
        if (durableArmed && cwd === worktreeRoot
          && command.length === 4
          && command[0] === 'hash-object' && command[1] === '-w'
          && command[2] === '--stdin' && command[3] === '--no-filters'
          && environment.objectDirectory === undefined) {
          postDurableObjectWrites += 1
        }
        return await runner.original(...args)
      })

      let started: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>>
      try {
        started = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } finally {
        persistence.restore()
        runner.restore()
      }

      expect(finalStatusViews).toHaveLength(2)
      expect(new Set(finalStatusViews).size).toBe(2)
      expect(postDurableObjectWrites).toBe(0)
      expect(materializeRead.opens).toBe(1)
      expect(materializeRead.readCalls).toBeGreaterThan(0)
      expect(materializeRead.bytesRead).toBe(selectedBytes.byteLength)
      expect(materializeRead.closes).toBe(1)
      expect(driftEvidence).toBeDefined()
      expect(started).toMatchObject({
        ok: true,
        snapshot: {
          state: 'failed',
          failure: { reason: 'observation-stale' },
          effect: 'none',
        },
      })
      if (driftEvidence === undefined) throw new Error('test did not inject the selected-byte drift')
      expect(driftEvidence.before).toEqual(selectedBytes)
      expect(driftEvidence.after).not.toEqual(driftEvidence.before)
      expect(driftEvidence.after.byteLength).toBe(driftEvidence.before.byteLength)
      expect(driftEvidence.afterIdentity).toEqual(driftEvidence.beforeIdentity)
      await expect(readFile(worktreePath)).resolves.toEqual(driftEvidence.after)
      const driftedObjectId = await gitTextWithInput(
        root,
        ['hash-object', '--stdin', '--no-filters'],
        driftEvidence.after,
      )
      expect(driftedObjectId).not.toBe(selectedObjectId)
      expect(liveOperationCount(execution)).toBe(0)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      const finalIndexInfo = await stat(indexPath, { bigint: true })
      expect({
        device: finalIndexInfo.dev.toString(),
        inode: finalIndexInfo.ino.toString(),
        mode: Number(finalIndexInfo.mode & 0o777n),
      }).toEqual({
        device: originalIndexInfo.dev.toString(),
        inode: originalIndexInfo.ino.toString(),
        mode: Number(originalIndexInfo.mode & 0o777n),
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(root, 'write-tree')).toBe(indexTree)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      expect(await gitText(root, 'diff', '--name-only')).toBe('tracked.txt')
      await expect(run('git', ['cat-file', '-e', selectedObjectId], {
        cwd: root,
        windowsHide: true,
      })).rejects.toBeDefined()
      await expect(run('git', ['cat-file', '-e', driftedObjectId], {
        cwd: root,
        windowsHide: true,
      })).rejects.toBeDefined()
      if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      const quarantinePath = `${plan.scratch.path}.cleanup-${plan.scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      for (const path of [lockPath, plan.pin.path, plan.scratch.path, quarantinePath, witnessPath]) {
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      for (const path of finalStatusViews) {
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }, 120_000)

    it.skipIf(process.platform === 'win32').each([
      { name: 'disappears', replacement: 'missing' },
      { name: 'becomes a regular file', replacement: 'regular' },
    ] as const)('keeps Stage planning when the selected symbolic link $name during its exact read', async ({
      replacement,
    }) => {
      const root = await repository()
      const state = { armed: false, reads: 0 }
      const node = {
        ...localGitMutationNodeAdapter,
        async readlink(path: string): Promise<Buffer> {
          if (!state.armed) return await readlink(path, { encoding: 'buffer' })
          state.armed = false
          state.reads += 1
          await unlink(path)
          if (replacement === 'regular') await writeFile(path, 'replacement file\n')
          return await readlink(path, { encoding: 'buffer' })
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, indexPath, linkPath } = await preparedSymlinkStage(
        execution,
        root,
        signal,
        replacement === 'missing' ? '1' : '2',
      )
      const originalIndex = await readFile(indexPath)
      const runner = mutationRunner(execution)
      let hashCalls = 0
      runner.replace(async (...args) => {
        if (args[1][0] === 'hash-object') hashCalls += 1
        return await runner.original(...args)
      })
      state.armed = true

      let started: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>>
      try {
        started = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } finally {
        runner.restore()
      }

      expect(started).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'planning', revision: 2 },
      })
      expect(state).toEqual({ armed: false, reads: 1 })
      expect(hashCalls).toBe(0)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
      if (replacement === 'missing') {
        await expect(lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect((await lstat(linkPath)).isFile()).toBe(true)
      }
    }, 90_000)

    it.skipIf(process.platform === 'win32').each([
      { name: 'filesystem error', kind: 'system' },
      { name: 'plain error', kind: 'plain' },
    ] as const)('classifies an exact symbolic-link $name without hashing bytes', async ({ kind }) => {
      const root = await repository()
      const systemFailure = Object.assign(new Error('injected readlink I/O failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'readlink',
      })
      const plainFailure = new Error('injected readlink program failure')
      const state = { armed: false, reads: 0 }
      const node = {
        ...localGitMutationNodeAdapter,
        async readlink(path: string): Promise<Buffer> {
          if (!state.armed) return await readlink(path, { encoding: 'buffer' })
          state.armed = false
          state.reads += 1
          throw kind === 'system' ? systemFailure : plainFailure
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, indexPath } = await preparedSymlinkStage(
        execution,
        root,
        signal,
        kind === 'system' ? '3' : '4',
      )
      const originalIndex = await readFile(indexPath)
      const runner = mutationRunner(execution)
      let hashCalls = 0
      runner.replace(async (...args) => {
        if (args[1][0] === 'hash-object') hashCalls += 1
        return await runner.original(...args)
      })
      state.armed = true

      let caught: unknown
      let started: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>> | undefined
      try {
        started = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } catch (error) {
        caught = error
      } finally {
        runner.restore()
      }

      if (kind === 'system') {
        expect(caught).toBeUndefined()
        expect(started).toMatchObject({
          ok: false,
          reason: 'unavailable',
          snapshot: { state: 'planning', revision: 2 },
        })
      } else {
        expect(caught).toBe(plainFailure)
        expect(started).toBeUndefined()
      }
      expect(state).toEqual({ armed: false, reads: 1 })
      expect(hashCalls).toBe(0)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it.skipIf(process.platform === 'win32')(
      'preserves an abort delivered while exact symbolic-link bytes are read', async () => {
        const root = await repository()
        const controller = new AbortController()
        const reason = new Error('caller stopped during readlink')
        const state = { armed: false, reads: 0 }
        const node = {
          ...localGitMutationNodeAdapter,
          async readlink(path: string): Promise<Buffer> {
            const bytes = await readlink(path, { encoding: 'buffer' })
            if (state.armed) {
              state.armed = false
              state.reads += 1
              controller.abort(reason)
            }
            return bytes
          },
        }
        const execution = await provider(root, { node })
        const { prepared, indexPath, linkPath, targetBytes } = await preparedSymlinkStage(
          execution,
          root,
          controller.signal,
          '5',
        )
        const originalIndex = await readFile(indexPath)
        const runner = mutationRunner(execution)
        let hashCalls = 0
        runner.replace(async (...args) => {
          if (args[1][0] === 'hash-object') hashCalls += 1
          return await runner.original(...args)
        })
        state.armed = true

        try {
          await expect(execution.startOperation(
            prepared.preparation.operation,
            prepared.acceptance,
            controller.signal,
          )).rejects.toBe(reason)
        } finally {
          runner.restore()
        }

        expect(state).toEqual({ armed: false, reads: 1 })
        expect(hashCalls).toBe(0)
        await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
        await expect(readlink(linkPath, { encoding: 'buffer' })).resolves.toEqual(targetBytes)
        await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
      }, 90_000)

    it.skipIf(process.platform === 'win32')(
      'stages a real symbolic link as its exact target bytes',
      async () => {
        const root = await repository()
        const execution = await provider(root, { node: scratchRootTrackingNodeAdapter() })
        const signal = new AbortController().signal
        const binding = await activeBinding(execution, root, signal)
        const worktreeRoot = binding.expectedInspection.trusted.canonicalWorktreePath
        const linkPath = join(worktreeRoot, 'link.txt')
        const targetBytes = Buffer.from('target-A')
        await symlink(targetBytes.toString('utf8'), linkPath)
        await expect(lstat(join(worktreeRoot, targetBytes.toString('utf8')))).rejects.toMatchObject({
          code: 'ENOENT',
        })
        const inspected = await execution.inspectProject({ binding }, signal)
        if (!inspected.ok) throw new Error(`test symbolic link was not inspectable: ${inspected.reason}`)
        const change = inspected.observation.changes.find(candidate => candidate.path === 'link.txt')
        if (change === undefined) throw new Error('test inspection exposed no symbolic-link change')
        const prepared = await prepareStageSelection(
          execution,
          binding,
          inspected,
          [{ id: change.id, fingerprint: change.fingerprint }],
          signal,
          'b',
        )
        const indexPath = join(binding.expectedInspection.trusted.canonicalGitDirectory, 'index')
        const lockPath = `${indexPath}.lock`
        const parent = await gitText(root, 'rev-parse', 'HEAD')
        const originalTree = await gitText(root, 'write-tree')
        const objectId = await gitTextWithInput(
          root,
          ['hash-object', '--stdin', '--no-filters'],
          targetBytes,
        )
        await expect(run('git', ['cat-file', '-e', objectId], {
          cwd: root,
          windowsHide: true,
        })).rejects.toBeDefined()

        const persistence = operationPersistence(execution)
        let durable: LocalHostOperationRecord | undefined
        let registeredScratchPath: string | undefined
        persistence.replace(async (record) => {
          if (registeredScratchPath === undefined && record.effectPlan?.kind === 'index') {
            registeredScratchPath = record.effectPlan.scratch.path
            if (!isTestOperationScratchWrapper(registeredScratchPath)) {
              throw new Error('test observed a symlink Stage scratch outside the owned temporary range')
            }
            const quarantinePath = `${registeredScratchPath}.cleanup-${record.effectPlan.scratch.markerDigest.slice(0, 32)}`
            const witnessPath = `${quarantinePath}.owner`
            for (const path of [registeredScratchPath, quarantinePath, witnessPath]) {
              if (!roots.includes(path)) roots.push(path)
            }
          }
          await persistence.original(record)
          if (durable === undefined && record.snapshot.state === 'publishing'
            && record.effectPlan?.kind === 'index' && record.effectPlan.publication === 'not-started') {
            durable = record
          }
        })
        const runner = mutationRunner(execution)
        const hashCommand = ['hash-object', '-w', '--stdin', '--no-filters']
        const hashes = { privateObjectDirectory: 0, mainObjectDirectory: 0 }
        let privateObjectDirectory: string | undefined
        runner.replace(async (...args) => {
          const [cwd, command, , environment, stdin] = args
          const exactHash = cwd === worktreeRoot && command.length === hashCommand.length
            && command.every((value, index) => value === hashCommand[index])
          if (exactHash) {
            expect(stdin).toBeDefined()
            expect(Buffer.from(stdin?.bytes ?? [])).toEqual(targetBytes)
            if (environment.objectDirectory === undefined) {
              expect(durable).toBeDefined()
              expect(environment.indexFile).toBeUndefined()
              hashes.mainObjectDirectory += 1
            } else {
              expect(durable).toBeUndefined()
              expect(environment.indexFile).toBeUndefined()
              expect(basename(environment.objectDirectory)).toBe('objects')
              const scratchPath = dirname(dirname(environment.objectDirectory))
              expect(isTestOperationScratchWrapper(scratchPath)).toBe(true)
              expect(roots).toContain(scratchPath)
              privateObjectDirectory = environment.objectDirectory
              hashes.privateObjectDirectory += 1
            }
          }
          return await runner.original(...args)
        })

        let started: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>>
        try {
          started = await execution.startOperation(
            prepared.preparation.operation,
            prepared.acceptance,
            signal,
          )
        } finally {
          persistence.restore()
          runner.restore()
        }

        expect(started).toMatchObject({
          ok: true,
          snapshot: { state: 'succeeded', result: { type: 'stage-files' } },
        })
        expect(hashes).toEqual({
          privateObjectDirectory: 1,
          mainObjectDirectory: 1,
        })
        expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
        await expect(readlink(linkPath, { encoding: 'buffer' })).resolves.toEqual(targetBytes)
        const stagedEntry = await run('git', ['ls-files', '-s', '-z', '--', 'link.txt'], {
          cwd: root,
          windowsHide: true,
          encoding: 'utf8',
        })
        expect(Buffer.from(stagedEntry.stdout, 'utf8')).toEqual(
          Buffer.from(`120000 ${objectId} 0\tlink.txt\0`),
        )
        const stagedBytes = await run('git', ['show', ':link.txt'], {
          cwd: root,
          windowsHide: true,
          encoding: 'buffer',
        })
        expect(stagedBytes.stdout).toEqual(targetBytes)
        expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
        expect(await gitText(root, 'write-tree')).not.toBe(originalTree)
        expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('link.txt')
        expect(await gitText(root, 'diff', '--name-only')).toBe('')
        await expect(run('git', ['cat-file', '-e', objectId], {
          cwd: root,
          windowsHide: true,
        })).resolves.toBeDefined()
        expect(liveOperationCount(execution)).toBe(0)
        if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable symlink Stage plan')
        const plan = durable.effectPlan
        expect(privateObjectDirectory).toBe(join(plan.scratch.path, 'payload', 'objects'))
        const quarantinePath = `${plan.scratch.path}.cleanup-${plan.scratch.markerDigest.slice(0, 32)}`
        const witnessPath = `${quarantinePath}.owner`
        for (const path of [lockPath, plan.pin.path, plan.scratch.path, quarantinePath, witnessPath]) {
          await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
        }
      },
      120_000,
    )

    it.skipIf(process.platform === 'win32')(
      'rejects a symbolic-link target drift after the final stable observation',
      async () => {
        const root = await repository()
        const targetA = Buffer.from('target-A')
        const targetB = Buffer.from('target-B')
        const trackedNode = scratchRootTrackingNodeAdapter()
        let durableArmed = false
        const materialization = { path: undefined as string | undefined }
        let materializationReads = 0
        let driftInjected = false
        const execution = await provider(root, {
          node: {
            ...trackedNode,
            async readlink(path) {
              if (durableArmed && !driftInjected && path === materialization.path) {
                materializationReads += 1
                await unlink(path)
                await symlink(targetB.toString('utf8'), path)
                driftInjected = true
              }
              return await trackedNode.readlink(path)
            },
          },
        })
        const signal = new AbortController().signal
        const binding = await activeBinding(execution, root, signal)
        const worktreeRoot = binding.expectedInspection.trusted.canonicalWorktreePath
        const linkPath = join(worktreeRoot, 'link.txt')
        materialization.path = linkPath
        await symlink(targetA.toString('utf8'), linkPath)
        const inspected = await execution.inspectProject({ binding }, signal)
        if (!inspected.ok) throw new Error(`test symbolic link was not inspectable: ${inspected.reason}`)
        const change = inspected.observation.changes.find(candidate => candidate.path === 'link.txt')
        if (change === undefined) throw new Error('test inspection exposed no symbolic-link change')
        const prepared = await prepareStageSelection(
          execution,
          binding,
          inspected,
          [{ id: change.id, fingerprint: change.fingerprint }],
          signal,
          'c',
        )
        const indexPath = join(binding.expectedInspection.trusted.canonicalGitDirectory, 'index')
        const lockPath = `${indexPath}.lock`
        const parent = await gitText(root, 'rev-parse', 'HEAD')
        const indexTree = await gitText(root, 'write-tree')
        const originalIndex = await readFile(indexPath)
        const originalIndexInfo = await stat(indexPath, { bigint: true })
        const targetAObjectId = await gitTextWithInput(
          root,
          ['hash-object', '--stdin', '--no-filters'],
          targetA,
        )
        const targetBObjectId = await gitTextWithInput(
          root,
          ['hash-object', '--stdin', '--no-filters'],
          targetB,
        )
        expect(targetBObjectId).not.toBe(targetAObjectId)
        for (const objectId of [targetAObjectId, targetBObjectId]) {
          await expect(run('git', ['cat-file', '-e', objectId], {
            cwd: root,
            windowsHide: true,
          })).rejects.toBeDefined()
        }

        const persistence = operationPersistence(execution)
        const runner = mutationRunner(execution)
        let durable: LocalHostOperationRecord | undefined
        let registeredScratchPath: string | undefined
        let postDurableObjectWrites = 0
        persistence.replace(async (record) => {
          if (registeredScratchPath === undefined && record.effectPlan?.kind === 'index') {
            registeredScratchPath = record.effectPlan.scratch.path
            if (!isTestOperationScratchWrapper(registeredScratchPath)) {
              throw new Error('test observed a stale symlink Stage scratch outside the owned temporary range')
            }
            const quarantinePath = `${registeredScratchPath}.cleanup-${record.effectPlan.scratch.markerDigest.slice(0, 32)}`
            const witnessPath = `${quarantinePath}.owner`
            for (const path of [registeredScratchPath, quarantinePath, witnessPath]) {
              if (!roots.includes(path)) roots.push(path)
            }
          }
          await persistence.original(record)
          if (!durableArmed && record.snapshot.state === 'publishing'
            && record.effectPlan?.kind === 'index' && record.effectPlan.publication === 'not-started') {
            durable = record
            durableArmed = true
          }
        })
        runner.replace(async (...args) => {
          const [cwd, command, , environment] = args
          if (durableArmed && cwd === worktreeRoot
            && command.length === 4
            && command[0] === 'hash-object' && command[1] === '-w'
            && command[2] === '--stdin' && command[3] === '--no-filters'
            && environment.objectDirectory === undefined) {
            postDurableObjectWrites += 1
          }
          return await runner.original(...args)
        })

        let started: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>>
        try {
          started = await execution.startOperation(
            prepared.preparation.operation,
            prepared.acceptance,
            signal,
          )
        } finally {
          persistence.restore()
          runner.restore()
        }

        expect(materializationReads).toBe(1)
        expect(driftInjected).toBe(true)
        expect(postDurableObjectWrites).toBe(0)
        expect(started).toMatchObject({
          ok: true,
          snapshot: {
            state: 'failed',
            failure: { reason: 'observation-stale' },
            effect: 'none',
          },
        })
        expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
        await expect(readlink(linkPath, { encoding: 'buffer' })).resolves.toEqual(targetB)
        await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
        const finalIndexInfo = await stat(indexPath, { bigint: true })
        expect({
          device: finalIndexInfo.dev.toString(),
          inode: finalIndexInfo.ino.toString(),
          mode: Number(finalIndexInfo.mode & 0o777n),
        }).toEqual({
          device: originalIndexInfo.dev.toString(),
          inode: originalIndexInfo.ino.toString(),
          mode: Number(originalIndexInfo.mode & 0o777n),
        })
        expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
        expect(await gitText(root, 'write-tree')).toBe(indexTree)
        expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
        expect(await gitText(root, 'status', '--porcelain', '--untracked-files=all')).toBe('?? link.txt')
        for (const objectId of [targetAObjectId, targetBObjectId]) {
          await expect(run('git', ['cat-file', '-e', objectId], {
            cwd: root,
            windowsHide: true,
          })).rejects.toBeDefined()
        }
        expect(liveOperationCount(execution)).toBe(0)
        if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no stale symlink Stage plan')
        const plan = durable.effectPlan
        const quarantinePath = `${plan.scratch.path}.cleanup-${plan.scratch.markerDigest.slice(0, 32)}`
        const witnessPath = `${quarantinePath}.owner`
        for (const path of [lockPath, plan.pin.path, plan.scratch.path, quarantinePath, witnessPath]) {
          await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
        }
      },
      120_000,
    )

    it('rejects a valid false object id from the post-durable worktree hash', async () => {
      const root = await repository()
      const execution = await provider(root, { node: scratchRootTrackingNodeAdapter() })
      const signal = new AbortController().signal
      const binding = await activeBinding(execution, root, signal)
      const worktreeRoot = binding.expectedInspection.trusted.canonicalWorktreePath
      const worktreePath = join(worktreeRoot, 'tracked.txt')
      const selectedBytes = Buffer.from('wrong object-id selected bytes\n')
      await writeFile(worktreePath, selectedBytes)
      const inspected = await execution.inspectProject({ binding }, signal)
      if (!inspected.ok) throw new Error(`test selected bytes were not inspectable: ${inspected.reason}`)
      const change = inspected.observation.changes.find(candidate => candidate.path === 'tracked.txt')
      if (change === undefined) throw new Error('test inspection exposed no selected regular file')
      expect(change).toMatchObject({ kind: 'ordinary', worktreeMode: '100644' })
      const prepared = await prepareStageSelection(
        execution,
        binding,
        inspected,
        [{ id: change.id, fingerprint: change.fingerprint }],
        signal,
        'd',
      )
      const indexPath = join(binding.expectedInspection.trusted.canonicalGitDirectory, 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const indexTree = await gitText(root, 'write-tree')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const expectedObjectId = await gitTextWithInput(
        root,
        ['hash-object', '--stdin', '--no-filters'],
        selectedBytes,
      )
      const falseObjectId = differentHex(expectedObjectId)
      expect(falseObjectId).toMatch(/^[0-9a-f]{40}$/u)
      expect(falseObjectId).not.toBe(expectedObjectId)
      for (const objectId of [expectedObjectId, falseObjectId]) {
        await expect(run('git', ['cat-file', '-e', objectId], {
          cwd: root,
          windowsHide: true,
        })).rejects.toBeDefined()
      }

      const persistence = operationPersistence(execution)
      const runner = mutationRunner(execution)
      let durableArmed = false
      let durable: LocalHostOperationRecord | undefined
      let registeredScratchPath: string | undefined
      let exactMainHashes = 0
      let postDurableIndexUpdates = 0
      persistence.replace(async (record) => {
        if (registeredScratchPath === undefined && record.effectPlan?.kind === 'index') {
          registeredScratchPath = record.effectPlan.scratch.path
          if (!isTestOperationScratchWrapper(registeredScratchPath)) {
            throw new Error('test observed a wrong-OID Stage scratch outside the owned temporary range')
          }
          const quarantinePath = `${registeredScratchPath}.cleanup-${record.effectPlan.scratch.markerDigest.slice(0, 32)}`
          const witnessPath = `${quarantinePath}.owner`
          for (const path of [registeredScratchPath, quarantinePath, witnessPath]) {
            if (!roots.includes(path)) roots.push(path)
          }
        }
        await persistence.original(record)
        if (!durableArmed && record.snapshot.state === 'publishing'
          && record.effectPlan?.kind === 'index' && record.effectPlan.publication === 'not-started') {
          durable = record
          durableArmed = true
        }
      })
      const hashCommand = ['hash-object', '-w', '--stdin', '--no-filters']
      runner.replace(async (...args) => {
        const [cwd, command, , environment, stdin] = args
        const exactMainHash = durableArmed && cwd === worktreeRoot
          && command.length === hashCommand.length
          && command.every((value, index) => value === hashCommand[index])
          && environment.objectDirectory === undefined
          && environment.indexFile === undefined
        if (exactMainHash) {
          exactMainHashes += 1
          expect(stdin).toBeDefined()
          expect(Buffer.from(stdin?.bytes ?? [])).toEqual(selectedBytes)
          const output = await runner.original(...args)
          expect(output.stderr.byteLength).toBe(0)
          expect(output.stdout.toString('utf8')).toMatch(new RegExp(`^${expectedObjectId}\\r?\\n$`, 'u'))
          return { ...output, stdout: Buffer.from(`${falseObjectId}\n`, 'ascii') }
        }
        if (durableArmed && command.length === 3
          && command[0] === 'update-index' && command[1] === '-z'
          && command[2] === '--index-info') {
          postDurableIndexUpdates += 1
        }
        return await runner.original(...args)
      })

      let started: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>>
      try {
        started = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } finally {
        persistence.restore()
        runner.restore()
      }

      expect(exactMainHashes).toBe(1)
      expect(postDurableIndexUpdates).toBe(0)
      expect(started).toMatchObject({
        ok: true,
        snapshot: {
          state: 'failed',
          failure: { reason: 'observation-stale' },
          effect: 'none',
        },
      })
      await expect(run('git', ['cat-file', '-e', expectedObjectId], {
        cwd: root,
        windowsHide: true,
      })).resolves.toBeDefined()
      await expect(run('git', ['cat-file', '-e', falseObjectId], {
        cwd: root,
        windowsHide: true,
      })).rejects.toBeDefined()
      await expect(readFile(worktreePath)).resolves.toEqual(selectedBytes)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      const finalIndexInfo = await stat(indexPath, { bigint: true })
      expect({
        device: finalIndexInfo.dev.toString(),
        inode: finalIndexInfo.ino.toString(),
        mode: Number(finalIndexInfo.mode & 0o777n),
      }).toEqual({
        device: originalIndexInfo.dev.toString(),
        inode: originalIndexInfo.ino.toString(),
        mode: Number(originalIndexInfo.mode & 0o777n),
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(root, 'write-tree')).toBe(indexTree)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      expect(await gitText(root, 'diff', '--name-only')).toBe('tracked.txt')
      expect(liveOperationCount(execution)).toBe(0)
      if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no wrong-OID Stage plan')
      const plan = durable.effectPlan
      const quarantinePath = `${plan.scratch.path}.cleanup-${plan.scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      for (const path of [lockPath, plan.pin.path, plan.scratch.path, quarantinePath, witnessPath]) {
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }, 120_000)

    it('keeps a prepared Stage retryable when the current index contains an invalid UTF-8 path', async () => {
      const root = await repository()
      const effects = mutationEffectTrackingNodeAdapter()
      const execution = await provider(root, { node: effects.node })
      const signal = new AbortController().signal
      const binding = await activeBinding(execution, root, signal)
      const worktreeRoot = binding.expectedInspection.trusted.canonicalWorktreePath
      const worktreePath = join(worktreeRoot, 'tracked.txt')
      const selectedBytes = Buffer.from('invalid UTF-8 path candidate\n')
      await writeFile(worktreePath, selectedBytes)
      const inspected = await execution.inspectProject({ binding }, signal)
      if (!inspected.ok) throw new Error(`test selected bytes were not inspectable: ${inspected.reason}`)
      const change = inspected.observation.changes.find(candidate => candidate.path === 'tracked.txt')
      if (change === undefined) throw new Error('test inspection exposed no legal tracked path')
      const prepared = await prepareStageSelection(
        execution,
        binding,
        inspected,
        [{ id: change.id, fingerprint: change.fingerprint }],
        signal,
        'e',
      )
      const indexPath = join(binding.expectedInspection.trusted.canonicalGitDirectory, 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const objectId = await gitText(root, 'rev-parse', 'HEAD:tracked.txt')
      const rawName = Buffer.concat([Buffer.from('invalid-'), Buffer.from([0xff]), Buffer.from('.txt')])
      const runner = mutationRunner(execution)
      let mutationCalls = 0
      runner.replace(async (...args) => {
        if (effects.state.active) mutationCalls += 1
        return await runner.original(...args)
      })

      let started: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>>
      try {
        await gitTextWithInput(
          root,
          ['update-index', '-z', '--index-info'],
          Buffer.concat([Buffer.from(`100644 ${objectId}\t`, 'ascii'), rawName, Buffer.from([0])]),
        )
        const driftedIndex = await readFile(indexPath)
        const driftedIndexInfo = await stat(indexPath, { bigint: true })
        expect(driftedIndex).not.toEqual(originalIndex)
        const rawStatus = await run('git', [
          'status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames',
        ], {
          cwd: root,
          windowsHide: true,
          encoding: 'buffer',
        })
        expect(rawStatus.stderr).toEqual(Buffer.alloc(0))
        expect(rawStatus.stdout.includes(0xff)).toBe(true)
        expect(rawStatus.stdout.includes(rawName)).toBe(true)

        started = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )

        expect(started).toMatchObject({
          ok: false,
          reason: 'unavailable',
          snapshot: { state: 'planning', revision: 2 },
        })
        expect(mutationCalls).toBe(0)
        expect(effects.state).toEqual({
          active: true,
          ownerOpenAttempts: 0,
          ownerCloses: 0,
          pinOpenAttempts: 0,
          links: 0,
          renames: 0,
        })
        expect(liveOperationCount(execution)).toBe(1)
        await expect(readFile(indexPath)).resolves.toEqual(driftedIndex)
        const finalIndexInfo = await stat(indexPath, { bigint: true })
        expect({
          device: finalIndexInfo.dev.toString(),
          inode: finalIndexInfo.ino.toString(),
          mode: Number(finalIndexInfo.mode & 0o777n),
        }).toEqual({
          device: driftedIndexInfo.dev.toString(),
          inode: driftedIndexInfo.ino.toString(),
          mode: Number(driftedIndexInfo.mode & 0o777n),
        })
        expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
        await expect(readFile(worktreePath)).resolves.toEqual(selectedBytes)
        await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        runner.restore()
        await writeFile(indexPath, originalIndex)
      }

      effects.state.active = false
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        new AbortController().signal,
      )).resolves.toMatchObject({
        ok: true,
        snapshot: { state: 'succeeded', result: { type: 'stage-files' } },
      })
      expect(liveOperationCount(execution)).toBe(0)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it('keeps Stage planning when a fresh inherited baseline exceeds its entry bound', async () => {
      const root = await repository()
      const effects = mutationEffectTrackingNodeAdapter()
      const execution = await provider(root, {
        node: effects.node,
        config: { baselineMaxEntries: 1 },
      })
      const signal = new AbortController().signal
      const binding = await activeBinding(execution, root, signal)
      const worktreeRoot = binding.expectedInspection.trusted.canonicalWorktreePath
      const worktreePath = join(worktreeRoot, 'tracked.txt')
      const extraPath = join(worktreeRoot, 'extra.txt')
      const selectedBytes = Buffer.from('bounded baseline candidate\n')
      await writeFile(worktreePath, selectedBytes)
      const inspected = await execution.inspectProject({ binding }, signal)
      if (!inspected.ok) throw new Error(`test selected bytes were not inspectable: ${inspected.reason}`)
      expect(inspected.preEffectBaseline).toMatchObject({ kind: 'complete' })
      const change = inspected.observation.changes.find(candidate => candidate.path === 'tracked.txt')
      if (change === undefined) throw new Error('test inspection exposed no bounded-baseline change')
      const prepared = await prepareStageSelection(
        execution,
        binding,
        inspected,
        [{ id: change.id, fingerprint: change.fingerprint }],
        signal,
        'f',
      )
      await writeFile(extraPath, 'second inherited change\n')
      const overBound = await execution.inspectProject({ binding }, signal)
      expect(overBound).toMatchObject({
        ok: true,
        preEffectBaseline: { kind: 'unavailable', reason: 'entry-limit' },
        observation: {
          structuredMutation: { available: false, blockers: ['baseline-unavailable'] },
        },
      })
      const indexPath = join(binding.expectedInspection.trusted.canonicalGitDirectory, 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const indexTree = await gitText(root, 'write-tree')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const runner = mutationRunner(execution)
      let mutationCalls = 0
      runner.replace(async (...args) => {
        if (effects.state.active) mutationCalls += 1
        return await runner.original(...args)
      })

      let started: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>>
      try {
        started = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } finally {
        runner.restore()
      }

      expect(started).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'planning', revision: 2 },
      })
      expect(mutationCalls).toBe(0)
      expect(effects.state).toEqual({
        active: true,
        ownerOpenAttempts: 0,
        ownerCloses: 0,
        pinOpenAttempts: 0,
        links: 0,
        renames: 0,
      })
      expect(liveOperationCount(execution)).toBe(1)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      const finalIndexInfo = await stat(indexPath, { bigint: true })
      expect({
        device: finalIndexInfo.dev.toString(),
        inode: finalIndexInfo.ino.toString(),
        mode: Number(finalIndexInfo.mode & 0o777n),
      }).toEqual({
        device: originalIndexInfo.dev.toString(),
        inode: originalIndexInfo.ino.toString(),
        mode: Number(originalIndexInfo.mode & 0o777n),
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(root, 'write-tree')).toBe(indexTree)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      const status = await run('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: root,
        windowsHide: true,
        encoding: 'utf8',
      })
      expect(status.stdout.trimEnd().split(/\r?\n/u).sort()).toEqual([
        ' M tracked.txt',
        '?? extra.txt',
      ].sort())
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      await rm(extraPath, { force: false })
      effects.state.active = false
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        new AbortController().signal,
      )).resolves.toMatchObject({
        ok: true,
        snapshot: { state: 'succeeded', result: { type: 'stage-files' } },
      })
      expect(liveOperationCount(execution)).toBe(0)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it('preserves caller abort from the outer stable-selection boundary', async () => {
      const root = await repository()
      const effects = mutationEffectTrackingNodeAdapter()
      const execution = await provider(root, { node: effects.node })
      const controller = new AbortController()
      const binding = await activeBinding(execution, root, controller.signal)
      const worktreeRoot = binding.expectedInspection.trusted.canonicalWorktreePath
      const worktreePath = join(worktreeRoot, 'tracked.txt')
      const selectedBytes = Buffer.from('outer stable-selection abort\n')
      await writeFile(worktreePath, selectedBytes)
      const indexPath = join(binding.expectedInspection.trusted.canonicalGitDirectory, 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const indexTree = await gitText(root, 'write-tree')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const abortReason = new Error('caller aborted after the final stable status observation')
      const runner = mutationRunner(execution)
      const finalStatusViews: string[] = []
      let mutationCalls = 0
      runner.replaceRun(async (...args) => {
        const [cwd, command] = args
        const exactFinalStatusWrite = command.length === 3
          && command[0] === `--git-dir=${cwd}`
          && command[1] === `--work-tree=${worktreeRoot}`
          && command[2] === 'write-tree'
        if (!exactFinalStatusWrite) return await runner.originalRun(...args)
        expect(dirname(cwd)).toBe(tmpdir())
        expect(basename(cwd)).toMatch(/^saki-git-view-/u)
        if (!roots.includes(cwd)) roots.push(cwd)
        const output = await runner.originalRun(...args)
        expect(output.stderr.byteLength).toBe(0)
        expect(output.stdout.toString('utf8')).toMatch(new RegExp(`^${indexTree}\\r?\\n$`, 'u'))
        expect(finalStatusViews).not.toContain(cwd)
        finalStatusViews.push(cwd)
        if (finalStatusViews.length === 2) controller.abort(abortReason)
        return output
      })
      runner.replace(async (...args) => {
        if (effects.state.active) mutationCalls += 1
        return await runner.original(...args)
      })

      try {
        await expect(execution.inspectProject({ binding }, controller.signal)).rejects.toBe(abortReason)
      } finally {
        runner.restore()
      }

      expect(finalStatusViews).toHaveLength(2)
      expect(new Set(finalStatusViews).size).toBe(2)
      expect(controller.signal.reason).toBe(abortReason)
      expect(mutationCalls).toBe(0)
      expect(effects.state).toEqual({
        active: true,
        ownerOpenAttempts: 0,
        ownerCloses: 0,
        pinOpenAttempts: 0,
        links: 0,
        renames: 0,
      })
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      const finalIndexInfo = await stat(indexPath, { bigint: true })
      expect({
        device: finalIndexInfo.dev.toString(),
        inode: finalIndexInfo.ino.toString(),
        mode: Number(finalIndexInfo.mode & 0o777n),
      }).toEqual({
        device: originalIndexInfo.dev.toString(),
        inode: originalIndexInfo.ino.toString(),
        mode: Number(originalIndexInfo.mode & 0o777n),
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(root, 'write-tree')).toBe(indexTree)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(readFile(worktreePath)).resolves.toEqual(selectedBytes)
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      for (const path of finalStatusViews) {
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }, 120_000)

    it('preserves caller abort from the mutation stable-selection boundary', async () => {
      const root = await repository()
      const effects = mutationEffectTrackingNodeAdapter()
      const execution = await provider(root, { node: effects.node })
      const setupSignal = new AbortController().signal
      const { prepared, binding } = await preparedStage(execution, root, setupSignal, '8', 78)
      const worktreeRoot = binding.expectedInspection.trusted.canonicalWorktreePath
      const indexPath = join(binding.expectedInspection.trusted.canonicalGitDirectory, 'index')
      const lockPath = `${indexPath}.lock`
      const world = await captureUnpublishedGitMutationWorld(root, indexPath, lockPath)
      const controller = new AbortController()
      const abortReason = new Error('caller aborted during mutation stable selection')
      const runner = mutationRunner(execution)
      const finalStatusViews: string[] = []
      let mutationCalls = 0
      runner.replaceRun(async (...args) => {
        const [cwd, command] = args
        const exactFinalStatusWrite = command.length === 3
          && command[0] === `--git-dir=${cwd}`
          && command[1] === `--work-tree=${worktreeRoot}`
          && command[2] === 'write-tree'
        if (!exactFinalStatusWrite) return await runner.originalRun(...args)
        expect(dirname(cwd)).toBe(tmpdir())
        expect(basename(cwd)).toMatch(/^saki-git-view-/u)
        if (!roots.includes(cwd)) roots.push(cwd)
        const output = await runner.originalRun(...args)
        expect(output.stderr.byteLength).toBe(0)
        expect(finalStatusViews).not.toContain(cwd)
        finalStatusViews.push(cwd)
        if (finalStatusViews.length === 2) controller.abort(abortReason)
        return output
      })
      runner.replace(async (...args) => {
        if (effects.state.active) mutationCalls += 1
        return await runner.original(...args)
      })

      try {
        await expect(execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          controller.signal,
        )).rejects.toBe(abortReason)
      } finally {
        runner.restore()
      }

      expect(finalStatusViews).toHaveLength(2)
      expect(new Set(finalStatusViews).size).toBe(2)
      expect(controller.signal.reason).toBe(abortReason)
      expect(mutationCalls).toBe(0)
      expect(effects.state).toEqual({
        active: true,
        ownerOpenAttempts: 0,
        ownerCloses: 0,
        pinOpenAttempts: 0,
        links: 0,
        renames: 0,
      })
      expect(liveOperationCount(execution)).toBe(1)
      await expectUnpublishedGitMutationWorld(world)
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        setupSignal,
      )).toMatchObject({ state: 'planning', revision: 2 })
      for (const path of finalStatusViews) {
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }

      effects.state.active = false
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        setupSignal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(liveOperationCount(execution)).toBe(0)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)
  })

  describe('cancel recovery and final publication races', () => {
    it('recovers an acknowledged-lost Stage publication before cancellation', async () => {
      const root = await repository()
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '1', 32)
      const persistence = operationPersistence(execution)
      const acknowledgementLoss = new Error('simulated Stage success acknowledgement loss')
      let succeeded: LocalHostOperationRecord | undefined
      persistence.replace(async (record) => {
        if (record.snapshot.state === 'succeeded' && record.effectPlan?.kind === 'index') {
          succeeded = record
          roots.push(record.effectPlan.scratch.path)
          throw acknowledgementLoss
        }
        await persistence.original(record)
      })

      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).rejects.toBe(acknowledgementLoss)
      persistence.restore()
      if (succeeded?.effectPlan?.kind !== 'index') throw new Error('test retained no succeeded Stage plan')

      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'succeeded', result: { type: 'stage-files' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(succeeded.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(succeeded.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 75_000)

    it('recovers an acknowledged-lost Commit publication before cancellation', async () => {
      const root = await repository()
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable, publishedCommit } = await captureAcknowledgedLostAttachedCommit(
        execution,
        root,
        signal,
        '2',
        33,
      )
      const laterCommit = await gitText(root, 'rev-parse', 'HEAD')
      expect(laterCommit).not.toBe(publishedCommit)

      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({
        state: 'succeeded',
        result: { type: 'commit', commitId: publishedCommit },
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(laterCommit)
      await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 75_000)

    it('does not cancel an attempting Commit while its reflog evidence is unavailable', async () => {
      const root = await repository()
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared } = await preparedCommit(
        execution,
        root,
        signal,
        '3',
        34,
        'attempting Commit candidate\n',
        'retain attempting Commit\n',
      )
      const persistence = operationPersistence(execution)
      const attemptLoss = new Error('simulated durable Commit attempt acknowledgement loss')
      let attempting: LocalHostOperationRecord | undefined
      persistence.replace(async (record) => {
        if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
          && record.effectPlan.publication === 'attempting') {
          attempting = record
          roots.push(record.effectPlan.scratch.path)
          await persistence.original(record)
          throw attemptLoss
        }
        await persistence.original(record)
      })

      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).rejects.toBe(attemptLoss)
      persistence.restore()
      if (attempting?.effectPlan?.kind !== 'commit') throw new Error('test retained no attempting Commit')
      const reflogPath = join(root, '.git', 'logs', ...attempting.effectPlan.targetRef.split('/'))
      const retainedReflogPath = `${reflogPath}.retained`
      await rename(reflogPath, retainedReflogPath)
      await mkdir(reflogPath)

      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'publishing', revision: attempting.snapshot.revision })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      await expect(stat(attempting.effectPlan.pin.path)).resolves.toBeDefined()
      await expect(stat(attempting.effectPlan.scratch.path)).resolves.toBeDefined()

      await rm(reflogPath, { recursive: true })
      await rename(retainedReflogPath, reflogPath)
      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'reconciliation-required', reason: 'evidence-conflict' })
      await expect(stat(attempting.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(attempting.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('does not cancel an attempting Stage while its index evidence disappears before open', async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const originalIndex = await readFile(indexPath)
      const state = { armed: false, removed: false }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async open(path, flags, mode) {
          if (state.armed && !state.removed && path === indexPath && flags === 'r') {
            await localGitMutationNodeAdapter.rm(path, { force: false })
            state.removed = true
          }
          return await localGitMutationNodeAdapter.open(path, flags, mode)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '4', 35)
      const persistence = operationPersistence(execution)
      const attemptLoss = new Error('simulated durable Stage attempt acknowledgement loss')
      let attempting: LocalHostOperationRecord | undefined
      persistence.replace(async (record) => {
        if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
          && record.effectPlan.publication === 'attempting') {
          attempting = record
          roots.push(record.effectPlan.scratch.path)
          await persistence.original(record)
          throw attemptLoss
        }
        await persistence.original(record)
      })

      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).rejects.toBe(attemptLoss)
      persistence.restore()
      if (attempting?.effectPlan?.kind !== 'index') throw new Error('test retained no attempting Stage')
      state.armed = true

      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'publishing', revision: attempting.snapshot.revision })
      expect(state.removed).toBe(true)
      await expect(stat(indexPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(attempting.effectPlan.pin.path)).resolves.toBeDefined()
      await expect(stat(attempting.effectPlan.scratch.path)).resolves.toBeDefined()

      state.armed = false
      await writeFile(indexPath, originalIndex)
      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'reconciliation-required', reason: 'evidence-conflict' })
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      await expect(stat(attempting.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(attempting.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('preserves a Commit target that changes between recovery and cancellation evidence', async () => {
      const root = await repository()
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedCommit(
        execution,
        root,
        signal,
        '5',
        36,
        'inter-read Commit candidate\n',
        'retain inter-read Commit target\n',
      )
      if (durable.effectPlan?.kind !== 'commit' || durable.request.type !== 'commit') {
        throw new Error('test retained no durable Commit plan')
      }
      const targetRef = durable.effectPlan.targetRef
      const alternate = await gitTextWithInput(
        root,
        ['commit-tree', durable.request.expected.index.treeId, '-p', parent],
        Buffer.from('external inter-read Commit\n', 'utf8'),
      )
      const runner = mutationRunner(execution)
      let targetReads = 0
      let targetChanged = false
      runner.replaceRun(async (...args) => {
        const [, command] = args
        if (command.length !== 4 || command[0] !== 'rev-parse' || command[1] !== '--verify'
          || command[2] !== '--end-of-options' || command[3] !== targetRef) {
          return await runner.originalRun(...args)
        }
        const result = await runner.originalRun(...args)
        targetReads += 1
        if (targetReads === 1) {
          await git(root, 'update-ref', targetRef, alternate, parent)
          targetChanged = true
        }
        return result
      })

      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
      runner.restore()
      expect({ targetReads, targetChanged }).toEqual({ targetReads: 2, targetChanged: true })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(alternate)
      await expect(stat(durable.effectPlan.pin.path)).resolves.toBeDefined()
      await expect(stat(durable.effectPlan.scratch.path)).resolves.toBeDefined()

      await git(root, 'update-ref', targetRef, parent, alternate)
      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('preserves an index that changes between recovery and cancellation evidence', async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const originalIndex = await readFile(indexPath)
      const state = { armed: false, indexReads: 0, changed: false }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async open(path, flags, mode) {
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (!state.armed || path !== indexPath || flags !== 'r') return handle
          return {
            ...handle,
            async close() {
              await handle.close()
              state.indexReads += 1
              if (state.indexReads === 1) {
                await writeFile(indexPath, Buffer.from([0x78]), { flag: 'a' })
                state.changed = true
              }
            },
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        '6',
        37,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      state.armed = true

      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
      expect(state).toEqual({ armed: true, indexReads: 2, changed: true })
      await expect(readFile(indexPath)).resolves.toEqual(Buffer.concat([originalIndex, Buffer.from([0x78])]))
      await expect(stat(durable.effectPlan.pin.path)).resolves.toBeDefined()
      await expect(stat(durable.effectPlan.scratch.path)).resolves.toBeDefined()

      await writeFile(indexPath, originalIndex)
      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('preserves a foreign Commit lock that replaces the owned link after attempting is durable', async () => {
      const root = await repository()
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared } = await preparedCommit(
        execution,
        root,
        signal,
        '7',
        38,
        'foreign Commit lock candidate\n',
        'preserve foreign Commit lock\n',
      )
      const persistence = operationPersistence(execution)
      let attempting: LocalHostOperationRecord | undefined
      let foreign: OwnedLockForeignReplacement | undefined
      persistence.replace(async (record) => {
        await persistence.original(record)
        if (attempting !== undefined || record.snapshot.state !== 'publishing'
          || record.effectPlan?.kind !== 'commit' || record.effectPlan.publication !== 'attempting') return
        attempting = record
        roots.push(record.effectPlan.scratch.path)
        foreign = await replaceOwnedLockWithForeignSameBytes(lockPath)
      })

      const started = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )
      persistence.restore()
      if (attempting?.effectPlan?.kind !== 'commit' || foreign === undefined) {
        throw new Error('test retained no attempting Commit replacement')
      }

      expect(started).toMatchObject({
        ok: true,
        snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      await expect(readFile(lockPath)).resolves.toEqual(foreign.bytes)
      const retainedForeign = await stat(lockPath, { bigint: true })
      expect({ device: retainedForeign.dev.toString(), inode: retainedForeign.ino.toString() }).toEqual(
        foreign.identity,
      )
      expect(foreign.identity).not.toEqual(attempting.effectPlan.pin.identity)
      await expect(stat(attempting.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(attempting.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await unlink(lockPath)
    }, 90_000)

    it('preserves a shared index that drifts after the private Stage target is frozen', async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const originalIndex = await readFile(indexPath)
      const state = {
        targetObserved: false,
        drifted: false,
        publishCalls: 0,
        scratchPath: undefined as string | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          if (basename(path) === 'target.index') {
            state.targetObserved = true
            if (state.scratchPath === undefined) {
              state.scratchPath = dirname(dirname(path))
              roots.push(state.scratchPath)
            }
          }
          if (path === indexPath && state.targetObserved && !state.drifted) {
            await writeFile(path, Buffer.from([0x79]), { flag: 'a' })
            state.drifted = true
          }
          return await localGitMutationNodeAdapter.lstat(path)
        },
        async rename(from, to) {
          if (from === `${indexPath}.lock` && to === indexPath) state.publishCalls += 1
          await localGitMutationNodeAdapter.rename(from, to)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '8', 39)

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: true,
        snapshot: {
          state: 'failed',
          failure: { reason: 'observation-stale' },
          effect: 'none',
        },
      })
      expect(state).toMatchObject({ targetObserved: true, drifted: true, publishCalls: 0 })
      await expect(readFile(indexPath)).resolves.toEqual(Buffer.concat([originalIndex, Buffer.from([0x79])]))
      await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
      if (state.scratchPath === undefined) throw new Error('test retained no Stage scratch path')
      await expect(stat(state.scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('preserves a foreign Stage lock that replaces the owned link after attempting is durable', async () => {
      const root = await repository()
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const originalIndex = await readFile(indexPath)
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '9', 40)
      const persistence = operationPersistence(execution)
      let attempting: LocalHostOperationRecord | undefined
      let foreign: OwnedLockForeignReplacement | undefined
      persistence.replace(async (record) => {
        await persistence.original(record)
        if (attempting !== undefined || record.snapshot.state !== 'publishing'
          || record.effectPlan?.kind !== 'index' || record.effectPlan.publication !== 'attempting') return
        attempting = record
        roots.push(record.effectPlan.scratch.path)
        foreign = await replaceOwnedLockWithForeignSameBytes(lockPath)
      })

      const started = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )
      persistence.restore()
      if (attempting?.effectPlan?.kind !== 'index' || foreign === undefined) {
        throw new Error('test retained no attempting Stage replacement')
      }

      expect(started).toMatchObject({
        ok: true,
        snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      await expect(readFile(lockPath)).resolves.toEqual(foreign.bytes)
      const retainedForeign = await stat(lockPath, { bigint: true })
      expect({ device: retainedForeign.dev.toString(), inode: retainedForeign.ino.toString() }).toEqual(
        foreign.identity,
      )
      expect(foreign.identity).not.toEqual(attempting.effectPlan.pin.identity)
      await expect(stat(attempting.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(attempting.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await unlink(lockPath)
    }, 90_000)

    it('preserves a foreign Stage lock that replaces the resumed owned link after attempting is durable', async () => {
      const root = await repository()
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const originalIndex = await readFile(indexPath)
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        'a',
        41,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const persistence = operationPersistence(execution)
      let attempting: LocalHostOperationRecord | undefined
      let foreign: OwnedLockForeignReplacement | undefined
      persistence.replace(async (record) => {
        await persistence.original(record)
        if (attempting !== undefined || record.snapshot.state !== 'publishing'
          || record.effectPlan?.kind !== 'index' || record.effectPlan.publication !== 'attempting') return
        attempting = record
        foreign = await replaceOwnedLockWithForeignSameBytes(lockPath)
      })

      const started = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )
      persistence.restore()
      if (attempting?.effectPlan?.kind !== 'index' || foreign === undefined) {
        throw new Error('test retained no resumed Stage replacement')
      }

      expect(started).toMatchObject({
        ok: true,
        snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      await expect(readFile(lockPath)).resolves.toEqual(foreign.bytes)
      const retainedForeign = await stat(lockPath, { bigint: true })
      expect({ device: retainedForeign.dev.toString(), inode: retainedForeign.ino.toString() }).toEqual(
        foreign.identity,
      )
      expect(foreign.identity).not.toEqual(attempting.effectPlan.pin.identity)
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await unlink(lockPath)
    }, 90_000)

    it('fails a schema-valid durable Stage whose planned safe path conflicts with the live selection', async () => {
      const root = await repository()
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const indexPath = join(root, '.git', 'index')
      const originalIndex = await readFile(indexPath)
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        'b',
        42,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const originalWorktree = await readFile(join(root, 'tracked.txt'))
      const planned = durable.effectPlan.changes[0]
      const publicChange = durable.effectPlan.result.changes[0]
      if (planned === undefined || publicChange === undefined) {
        throw new Error('test retained no durable Stage change')
      }
      const conflictingPath = 'semantic-corruption.txt'
      const conflicting = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
        ...durable,
        effectPlan: {
          ...durable.effectPlan,
          changes: [{
            ...planned,
            path: conflictingPath,
            pathBytesBase64: Buffer.from(conflictingPath, 'utf8').toString('base64'),
          }],
          result: {
            ...durable.effectPlan.result,
            changes: [{ ...publicChange, path: conflictingPath }],
          },
        },
      })
      await operationPersistence(execution).original(conflicting)

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: true,
        snapshot: {
          state: 'failed',
          failure: { reason: 'observation-stale' },
          effect: 'none',
        },
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      await expect(readFile(join(root, 'tracked.txt'))).resolves.toEqual(originalWorktree)
      await expect(stat(join(root, conflictingPath))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)
  })

  describe('scratch creation and ownership Node boundaries', () => {
    it('preserves a payload replaced while Commit reads its source index', async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-commit-source-index-payload-race-'))
      roots.push(holdingRoot)
      const ownedPayloadStash = join(holdingRoot, 'owned-payload')
      const sentinel = Buffer.from('foreign Commit planning payload\n', 'utf8')
      const tracked = scratchRootTrackingNodeAdapter()
      const state = {
        armed: false,
        injected: false,
        descendantNodeCalls: 0,
        scratchPath: undefined as string | undefined,
        payloadPath: undefined as string | undefined,
        foreignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          if (state.injected && state.payloadPath !== undefined
            && path.startsWith(`${state.payloadPath}${sep}`)) state.descendantNodeCalls += 1
          return await tracked.lstat(path)
        },
        async open(path, flags, mode) {
          if (flags === 'wx' && basename(path) === 'owner'
            && isTestOperationScratchWrapper(dirname(path))) {
            state.scratchPath = dirname(path)
            state.payloadPath = join(state.scratchPath, 'payload')
          }
          if (state.injected && state.payloadPath !== undefined
            && path.startsWith(`${state.payloadPath}${sep}`)) state.descendantNodeCalls += 1
          const handle = await tracked.open(path, flags, mode)
          if (!state.armed || state.injected || path !== indexPath || flags !== 'r'
            || state.payloadPath === undefined) return handle
          return {
            ...handle,
            async read(buffer, offset, length, position) {
              const result = await handle.read(buffer, offset, length, position)
              if (state.injected || result.bytesRead === 0 || state.payloadPath === undefined) return result
              await rename(state.payloadPath, ownedPayloadStash)
              await mkdir(state.payloadPath, { mode: 0o700 })
              await writeFile(join(state.payloadPath, 'foreign-sentinel'), sentinel, {
                flag: 'wx',
                mode: 0o600,
              })
              const foreign = await stat(state.payloadPath, { bigint: true })
              state.foreignIdentity = {
                device: foreign.dev.toString(),
                inode: foreign.ino.toString(),
              }
              state.injected = true
              return result
            },
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedCommit(
        execution,
        root,
        signal,
        '0',
        77,
        'source-index payload race candidate\n',
        'reject source-index payload race\n',
      )
      const world = await captureUnpublishedGitMutationWorld(root, indexPath, lockPath)
      const runner = mutationRunner(execution)
      let postInjectionGitCalls = 0
      runner.replace(async (...args) => {
        if (state.injected) postInjectionGitCalls += 1
        return await runner.original(...args)
      })
      runner.replaceRun(async (...args) => {
        if (state.injected) postInjectionGitCalls += 1
        return await runner.originalRun(...args)
      })
      state.armed = true

      const started = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      ).finally(() => { runner.restore() })

      expect(started).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'planning', revision: 2 },
      })
      expect(state).toMatchObject({
        armed: true,
        injected: true,
        descendantNodeCalls: 0,
      })
      expect(postInjectionGitCalls).toBe(0)
      if (state.scratchPath === undefined || state.payloadPath === undefined) {
        throw new Error('test retained no Commit planning scratch')
      }
      const foreign = await stat(state.payloadPath, { bigint: true })
      expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).toEqual(
        state.foreignIdentity,
      )
      await expect(readFile(join(state.payloadPath, 'foreign-sentinel'))).resolves.toEqual(sentinel)
      await expect(stat(join(state.payloadPath, 'commit.index'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(ownedPayloadStash, 'commit.index'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(state.scratchPath)).resolves.toBeDefined()
      await expectUnpublishedGitMutationWorld(world)
    }, 120_000)

    it('preserves a payload replaced while durable Stage validates its pin', async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-stage-pin-payload-race-'))
      roots.push(holdingRoot)
      const ownedPayloadStash = join(holdingRoot, 'owned-payload')
      const sentinel = Buffer.from('foreign durable Stage payload\n', 'utf8')
      const tracked = scratchRootTrackingNodeAdapter()
      const state = {
        armed: false,
        injected: false,
        descendantNodeCalls: 0,
        pinPath: undefined as string | undefined,
        payloadPath: undefined as string | undefined,
        foreignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          if (state.injected && state.payloadPath !== undefined
            && path.startsWith(`${state.payloadPath}${sep}`)) state.descendantNodeCalls += 1
          return await tracked.lstat(path)
        },
        async open(path, flags, mode) {
          if (state.injected && state.payloadPath !== undefined
            && path.startsWith(`${state.payloadPath}${sep}`)) state.descendantNodeCalls += 1
          const handle = await tracked.open(path, flags, mode)
          if (!state.armed || state.injected || path !== state.pinPath || flags !== 'r'
            || state.payloadPath === undefined) return handle
          return {
            ...handle,
            async read(buffer, offset, length, position) {
              const result = await handle.read(buffer, offset, length, position)
              if (state.injected || result.bytesRead === 0 || state.payloadPath === undefined) return result
              await rename(state.payloadPath, ownedPayloadStash)
              await cp(ownedPayloadStash, state.payloadPath, { recursive: true })
              await writeFile(join(state.payloadPath, 'foreign-sentinel'), sentinel, {
                flag: 'wx',
                mode: 0o600,
              })
              const foreign = await stat(state.payloadPath, { bigint: true })
              state.foreignIdentity = {
                device: foreign.dev.toString(),
                inode: foreign.ino.toString(),
              }
              state.injected = true
              return result
            },
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        '1',
        78,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      state.pinPath = plan.pin.path
      state.payloadPath = join(plan.scratch.path, 'payload')
      const targetIndexBytes = await readFile(join(state.payloadPath, 'target.index'))
      const world = await captureUnpublishedGitMutationWorld(root, indexPath, lockPath)
      const pinBytes = await readFile(plan.pin.path)
      const runner = mutationRunner(execution)
      let postInjectionGitCalls = 0
      runner.replace(async (...args) => {
        if (state.injected) postInjectionGitCalls += 1
        return await runner.original(...args)
      })
      runner.replaceRun(async (...args) => {
        if (state.injected) postInjectionGitCalls += 1
        return await runner.originalRun(...args)
      })
      state.armed = true

      const resumed = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      ).finally(() => { runner.restore() })

      expect(resumed).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })
      expect(state).toMatchObject({
        armed: true,
        injected: true,
        descendantNodeCalls: 0,
      })
      expect(postInjectionGitCalls).toBe(0)
      const foreign = await stat(state.payloadPath, { bigint: true })
      expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).toEqual(
        state.foreignIdentity,
      )
      await expect(readFile(join(state.payloadPath, 'foreign-sentinel'))).resolves.toEqual(sentinel)
      await expect(readFile(join(state.payloadPath, 'target.index'))).resolves.toEqual(targetIndexBytes)
      await expect(readFile(join(ownedPayloadStash, 'target.index'))).resolves.toEqual(targetIndexBytes)
      await expect(readFile(plan.pin.path)).resolves.toEqual(pinBytes)
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()
      await expectUnpublishedGitMutationWorld(world)
    }, 120_000)

    it('keeps a durable Stage retryable when a copied real directory replaces its payload', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-runtime-payload-directory-'))
      roots.push(holdingRoot)
      const ownedPayloadStash = join(holdingRoot, 'owned-payload')
      const foreignPayloadStash = join(holdingRoot, 'foreign-payload')
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'c', 73)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      const payloadPath = join(plan.scratch.path, 'payload')
      const indexPath = join(root, '.git', 'index')
      const originalIndex = await readFile(indexPath)
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      await rename(payloadPath, ownedPayloadStash)
      await cp(ownedPayloadStash, payloadPath, { recursive: true })
      const foreignPayload = await stat(payloadPath, { bigint: true })
      expect({ device: foreignPayload.dev.toString(), inode: foreignPayload.ino.toString() }).not.toEqual(
        plan.scratch.payloadIdentity,
      )

      const resumed = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )

      expect(resumed).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).resolves.toBeDefined()
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()

      await rename(payloadPath, foreignPayloadStash)
      await rename(ownedPayloadStash, payloadPath)
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    }, 90_000)

    it('keeps a durable Commit retryable when a directory link replaces its payload', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-runtime-payload-link-'))
      roots.push(holdingRoot)
      const ownedPayloadStash = join(holdingRoot, 'owned-payload')
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedCommit(
        execution,
        root,
        signal,
        'd',
        74,
        'runtime payload link candidate\n',
        'reject linked runtime payload\n',
      )
      if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
      const plan = durable.effectPlan
      const payloadPath = join(plan.scratch.path, 'payload')
      const indexPath = join(root, '.git', 'index')
      const originalIndex = await readFile(indexPath)
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      await rename(payloadPath, ownedPayloadStash)
      try {
        await symlink(ownedPayloadStash, payloadPath, process.platform === 'win32' ? 'junction' : 'dir')
        expect((await lstat(payloadPath)).isSymbolicLink()).toBe(true)

        const resumed = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )

        expect(resumed).toMatchObject({
          ok: false,
          reason: 'unavailable',
          snapshot: { state: 'publishing', revision: durable.snapshot.revision },
        })
        expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
        await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
        await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(plan.pin.path)).resolves.toBeDefined()
        await expect(lstat(payloadPath)).resolves.toMatchObject({})

        await unlink(payloadPath)
        await rename(ownedPayloadStash, payloadPath)
        await expect(execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      } finally {
        await unlinkTestSymbolicLink(payloadPath)
      }
    }, 90_000)

    it('keeps a durable Unstage retryable before entering a file replacement payload', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-runtime-payload-file-'))
      roots.push(holdingRoot)
      const ownedPayloadStash = join(holdingRoot, 'owned-payload')
      const replacement = Buffer.from('foreign runtime payload file\n', 'utf8')
      const tracked = scratchRootTrackingNodeAdapter()
      const state = { payloadPath: undefined as string | undefined, descendantReads: 0 }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          if (state.payloadPath !== undefined && path.startsWith(`${state.payloadPath}${sep}`)) {
            state.descendantReads += 1
          }
          return await tracked.lstat(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedUnstage(execution, root, signal, 'e', 75)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Unstage plan')
      const plan = durable.effectPlan
      const payloadPath = join(plan.scratch.path, 'payload')
      const indexPath = join(root, '.git', 'index')
      const originalIndex = await readFile(indexPath)
      state.payloadPath = payloadPath
      await rename(payloadPath, ownedPayloadStash)
      await writeFile(payloadPath, replacement, { flag: 'wx', mode: 0o600 })

      const resumed = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )

      expect(resumed).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })
      expect(state.descendantReads).toBe(0)
      await expect(readFile(payloadPath)).resolves.toEqual(replacement)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).resolves.toBeDefined()

      await unlink(payloadPath)
      await rename(ownedPayloadStash, payloadPath)
      state.payloadPath = undefined
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    }, 90_000)

    it('does not enter a linked hooks payload after Commit attempting is durable', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-attempting-payload-link-'))
      roots.push(holdingRoot)
      const ownedPayloadStash = join(holdingRoot, 'owned-payload')
      const linkedPayloadTarget = join(holdingRoot, 'linked-payload')
      const sentinel = await gitProgramSentinel('saki-attempting-payload-hook-')
      await sentinel.installHooks('reference-transaction')
      const execution = await provider(root, { node: scratchRootTrackingNodeAdapter() })
      const signal = new AbortController().signal
      const { prepared } = await preparedCommit(
        execution,
        root,
        signal,
        'f',
        76,
        'attempting payload link candidate\n',
        'reject attempting payload link\n',
      )
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const indexPath = join(root, '.git', 'index')
      const originalIndex = await readFile(indexPath)
      const persistence = operationPersistence(execution)
      const runner = mutationRunner(execution)
      let attempting: LocalHostOperationRecord | undefined
      let payloadPath: string | undefined
      let updateRefCalls = 0
      runner.replace(async (...args) => {
        const [, command] = args
        if (command[0] === 'update-ref') updateRefCalls += 1
        return await runner.original(...args)
      })
      persistence.replace(async (record) => {
        await persistence.original(record)
        if (attempting !== undefined || record.snapshot.state !== 'publishing'
          || record.effectPlan?.kind !== 'commit' || record.effectPlan.publication !== 'attempting') return
        attempting = record
        payloadPath = join(record.effectPlan.scratch.path, 'payload')
        await rename(payloadPath, ownedPayloadStash)
        await cp(ownedPayloadStash, linkedPayloadTarget, { recursive: true })
        await cp(
          join(sentinel.root, 'reference-transaction'),
          join(linkedPayloadTarget, 'hooks', 'reference-transaction'),
        )
        await symlink(
          linkedPayloadTarget,
          payloadPath,
          process.platform === 'win32' ? 'junction' : 'dir',
        )
      })

      try {
        const started = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )

        expect(attempting?.effectPlan?.kind).toBe('commit')
        expect(payloadPath).toBeDefined()
        expect(started).toMatchObject({
          ok: true,
          snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
        })
        expect(updateRefCalls).toBe(0)
        await expect(stat(sentinel.marker)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
        await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
        await expect(stat(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
        if (attempting?.effectPlan?.kind !== 'commit') throw new Error('test retained no attempting Commit')
        await expect(stat(attempting.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
        if (payloadPath === undefined) throw new Error('test retained no linked payload path')
        expect((await lstat(payloadPath)).isSymbolicLink()).toBe(true)
      } finally {
        persistence.restore()
        runner.restore()
        if (payloadPath !== undefined) {
          await unlinkTestSymbolicLink(payloadPath)
          try {
            await rename(ownedPayloadStash, payloadPath)
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          }
        }
      }
    }, 90_000)

    it('preserves a non-directory that replaces a newly allocated scratch wrapper', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-scratch-create-boundary-'))
      roots.push(holdingRoot)
      const sentinel = Buffer.from('foreign scratch wrapper\n', 'utf8')
      const state = {
        armed: false,
        injected: false,
        pinCreates: 0,
        linkCalls: 0,
        scratchPath: undefined as string | undefined,
        stashedPath: undefined as string | undefined,
        originalIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
        payloadIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
        foreignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          const info = await localGitMutationNodeAdapter.lstat(path)
          const isScratchWrapper = isTestOperationScratchWrapper(path)
          if (isScratchWrapper && !roots.includes(path)) roots.push(path)
          if (!state.armed || state.injected || !isScratchWrapper) return info
          state.injected = true
          state.scratchPath = path
          state.stashedPath = join(holdingRoot, 'owned')
          state.originalIdentity = { device: info.dev.toString(), inode: info.ino.toString() }
          await localGitMutationNodeAdapter.rename(path, state.stashedPath)
          await writeFile(path, sentinel, { flag: 'wx', mode: 0o600 })
          const foreign = await localGitMutationNodeAdapter.lstat(path)
          state.foreignIdentity = { device: foreign.dev.toString(), inode: foreign.ino.toString() }
          return foreign
        },
        async open(path, flags, mode) {
          if (flags === 'wx' && path.endsWith('.pin')) state.pinCreates += 1
          return await localGitMutationNodeAdapter.open(path, flags, mode)
        },
        async link(from, to) {
          state.linkCalls += 1
          await localGitMutationNodeAdapter.link(from, to)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '4', 50)
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      state.armed = true

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'planning', revision: 2 },
      })

      expect(state).toMatchObject({ injected: true, pinCreates: 0, linkCalls: 0 })
      if (state.scratchPath === undefined || state.stashedPath === undefined) {
        throw new Error('test retained no replaced scratch wrapper')
      }
      expect(await readFile(state.scratchPath)).toEqual(sentinel)
      const foreign = await stat(state.scratchPath, { bigint: true })
      expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).toEqual(state.foreignIdentity)
      const stashed = await stat(state.stashedPath, { bigint: true })
      expect({ device: stashed.dev.toString(), inode: stashed.ino.toString() }).toEqual(state.originalIdentity)
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await stat(indexPath, { bigint: true })).toMatchObject({
        dev: originalIndexInfo.dev,
        ino: originalIndexInfo.ino,
        mode: originalIndexInfo.mode,
      })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      state.armed = false
      await unlink(state.scratchPath)
      await localGitMutationNodeAdapter.rmdir(state.stashedPath)
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('rolls back a scratch whose owner grows after its marker write', async () => {
      const root = await repository()
      const state = {
        injected: false,
        ownerStatCalls: 0,
        ownerCloseCalls: 0,
        ownerLstats: 0,
        ownerRemovals: 0,
        wrapperLstats: 0,
        wrapperRemovals: 0,
        expectedCompleteSize: undefined as bigint | undefined,
        completeSize: undefined as bigint | undefined,
        scratchPath: undefined as string | undefined,
        ownerPath: undefined as string | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          if (isTestOperationScratchWrapper(path)) {
            state.scratchPath ??= path
            if (!roots.includes(path)) roots.push(path)
          }
          if (path === state.ownerPath) state.ownerLstats += 1
          if (path === state.scratchPath) state.wrapperLstats += 1
          return await localGitMutationNodeAdapter.lstat(path)
        },
        async open(path, flags, mode) {
          const isOwnerCreate = !state.injected && flags === 'wx' && basename(path) === 'owner'
            && basename(dirname(path)).startsWith('saki-host-operation-')
          if (isOwnerCreate) {
            state.scratchPath ??= dirname(path)
            state.ownerPath = path
            if (!roots.includes(state.scratchPath)) roots.push(state.scratchPath)
          }
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (!isOwnerCreate) return handle
          return {
            ...handle,
            async stat() {
              const info = await handle.stat()
              state.ownerStatCalls += 1
              if (state.ownerStatCalls === 2) state.completeSize = info.size
              return info
            },
            async writeFile(bytes) {
              await handle.writeFile(bytes)
              await handle.writeFile(Buffer.from([0x78]))
              state.expectedCompleteSize = BigInt(bytes.byteLength + 1)
              state.injected = true
            },
            async close() {
              state.ownerCloseCalls += 1
              await handle.close()
            },
          }
        },
        async rm(path, options) {
          if (path === state.ownerPath) state.ownerRemovals += 1
          await localGitMutationNodeAdapter.rm(path, options)
        },
        async rmdir(path) {
          if (path === state.scratchPath) state.wrapperRemovals += 1
          await localGitMutationNodeAdapter.rmdir(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '5', 51)
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'planning', revision: 2 },
      })

      expect(state).toMatchObject({
        injected: true,
        ownerStatCalls: 2,
        ownerCloseCalls: 1,
        ownerLstats: 1,
        ownerRemovals: 1,
        wrapperLstats: 2,
        wrapperRemovals: 1,
      })
      expect(state.completeSize).toBe(state.expectedCompleteSize)
      if (state.scratchPath === undefined) throw new Error('test retained no grown-owner scratch path')
      await expect(stat(state.scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('preserves both worlds when a synced scratch wrapper is replaced before confirmation', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-scratch-sync-boundary-'))
      roots.push(holdingRoot)
      const sentinel = Buffer.from('foreign wrapper after directory sync\n', 'utf8')
      const state = {
        armed: false,
        injected: false,
        syncCalls: 0,
        wrapperLstats: 0,
        pinCreates: 0,
        linkCalls: 0,
        scratchPath: undefined as string | undefined,
        stashedPath: undefined as string | undefined,
        originalIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
        payloadIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
        foreignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          const info = await localGitMutationNodeAdapter.lstat(path)
          if (isTestOperationScratchWrapper(path)) {
            if (state.scratchPath === undefined) {
              state.scratchPath = path
              state.originalIdentity = {
                device: info.dev.toString(),
                inode: info.ino.toString(),
              }
            }
            if (!roots.includes(path)) roots.push(path)
          }
          if (path === state.scratchPath) state.wrapperLstats += 1
          return info
        },
        async open(path, flags, mode) {
          if (flags === 'wx' && path.endsWith('.pin')) state.pinCreates += 1
          return await localGitMutationNodeAdapter.open(path, flags, mode)
        },
        async link(from, to) {
          state.linkCalls += 1
          await localGitMutationNodeAdapter.link(from, to)
        },
        async syncDirectory(path) {
          await localGitMutationNodeAdapter.syncDirectory(path)
          if (!state.armed || state.injected || path !== state.scratchPath) return
          state.syncCalls += 1
          state.injected = true
          const payload = await localGitMutationNodeAdapter.lstat(join(path, 'payload'))
          state.payloadIdentity = { device: payload.dev.toString(), inode: payload.ino.toString() }
          state.stashedPath = join(holdingRoot, 'owned')
          await localGitMutationNodeAdapter.rename(path, state.stashedPath)
          await mkdir(path, { mode: 0o700 })
          await writeFile(join(path, 'foreign-sentinel'), sentinel, { flag: 'wx', mode: 0o600 })
          const foreign = await localGitMutationNodeAdapter.lstat(path)
          state.foreignIdentity = { device: foreign.dev.toString(), inode: foreign.ino.toString() }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '6', 52)
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      state.armed = true

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'planning', revision: 2 },
      })

      expect(state).toMatchObject({
        injected: true,
        syncCalls: 1,
        wrapperLstats: 3,
        pinCreates: 0,
        linkCalls: 0,
      })
      if (state.scratchPath === undefined || state.stashedPath === undefined) {
        throw new Error('test retained no post-sync scratch replacement')
      }
      const foreign = await stat(state.scratchPath, { bigint: true })
      expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).toEqual(state.foreignIdentity)
      expect(await readFile(join(state.scratchPath, 'foreign-sentinel'))).toEqual(sentinel)
      const stashed = await stat(state.stashedPath, { bigint: true })
      expect({ device: stashed.dev.toString(), inode: stashed.ino.toString() }).toEqual(state.originalIdentity)
      await expect(stat(join(state.stashedPath, 'owner'))).resolves.toBeDefined()
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      await unlink(join(state.scratchPath, 'foreign-sentinel'))
      await localGitMutationNodeAdapter.rmdir(state.scratchPath)
      const payload = await localGitMutationNodeAdapter.lstat(join(state.stashedPath, 'payload'))
      expect({ device: payload.dev.toString(), inode: payload.ino.toString() }).toEqual(state.payloadIdentity)
      await localGitMutationNodeAdapter.rmdir(join(state.stashedPath, 'payload'))
      await unlink(join(state.stashedPath, 'owner'))
      await localGitMutationNodeAdapter.rmdir(state.stashedPath)
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('preserves the exact owner-open failure when the empty scratch disappears first', async () => {
      const root = await repository()
      const state = {
        injected: false,
        ownerOpenCalls: 0,
        ownerHandleStats: 0,
        ownerHandleCloses: 0,
        productionWrapperRemovals: 0,
        scratchPath: undefined as string | undefined,
        failure: undefined as unknown,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          const info = await localGitMutationNodeAdapter.lstat(path)
          if (isTestOperationScratchWrapper(path)) {
            state.scratchPath ??= path
            if (!roots.includes(path)) roots.push(path)
          }
          return info
        },
        async open(path, flags, mode) {
          if (state.injected || flags !== 'wx' || basename(path) !== 'owner'
            || dirname(path) !== state.scratchPath) {
            return await localGitMutationNodeAdapter.open(path, flags, mode)
          }
          state.injected = true
          state.ownerOpenCalls += 1
          await localGitMutationNodeAdapter.rmdir(dirname(path))
          try {
            const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
            return {
              ...handle,
              async stat() {
                state.ownerHandleStats += 1
                return await handle.stat()
              },
              async close() {
                state.ownerHandleCloses += 1
                await handle.close()
              },
            }
          } catch (error) {
            state.failure = error
            throw error
          }
        },
        async rmdir(path) {
          if (path === state.scratchPath) state.productionWrapperRemovals += 1
          await localGitMutationNodeAdapter.rmdir(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '7', 53)
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)

      let caught: unknown
      try {
        await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } catch (error) {
        caught = error
      }

      expect(caught).toBe(state.failure)
      expect(caught).toMatchObject({ code: 'ENOENT' })
      expect(state).toMatchObject({
        injected: true,
        ownerOpenCalls: 1,
        ownerHandleStats: 0,
        ownerHandleCloses: 0,
        productionWrapperRemovals: 0,
      })
      if (state.scratchPath === undefined) throw new Error('test retained no vanished scratch path')
      await expect(stat(state.scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
        state: 'planning',
        revision: 2,
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('keeps the primary scratch failure above close and rollback acknowledgement losses', async () => {
      const root = await repository()
      const primaryFailure = new Error('injected scratch owner sync failure')
      const closeFailure = new Error('injected scratch owner close acknowledgement loss')
      const ownerRemovalFailure = new Error('injected scratch owner removal acknowledgement loss')
      const wrapperRemovalFailure = new Error('injected scratch wrapper removal acknowledgement loss')
      const state = {
        armed: false,
        injected: false,
        syncCalls: 0,
        closeCalls: 0,
        ownerLstats: 0,
        ownerRemovals: 0,
        wrapperLstats: 0,
        wrapperRemovals: 0,
        ownerRemoved: false,
        wrapperRemoved: false,
        scratchPath: undefined as string | undefined,
        ownerPath: undefined as string | undefined,
        postCloseStat: undefined as (() => Promise<unknown>) | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          const info = await localGitMutationNodeAdapter.lstat(path)
          if (isTestOperationScratchWrapper(path)) {
            state.scratchPath ??= path
            if (!roots.includes(path)) roots.push(path)
          }
          if (path === state.ownerPath) state.ownerLstats += 1
          if (path === state.scratchPath) state.wrapperLstats += 1
          return info
        },
        async open(path, flags, mode) {
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (!state.armed || state.injected || flags !== 'wx' || basename(path) !== 'owner'
            || dirname(path) !== state.scratchPath) return handle
          state.ownerPath = path
          state.postCloseStat = async () => await handle.stat()
          return {
            ...handle,
            async sync() {
              await handle.sync()
              state.syncCalls += 1
              state.injected = true
              throw primaryFailure
            },
            async close() {
              state.closeCalls += 1
              await handle.close()
              throw closeFailure
            },
          }
        },
        async rm(path, options) {
          if (path !== state.ownerPath) {
            await localGitMutationNodeAdapter.rm(path, options)
            return
          }
          state.ownerRemovals += 1
          await localGitMutationNodeAdapter.rm(path, options)
          state.ownerRemoved = true
          throw ownerRemovalFailure
        },
        async rmdir(path) {
          if (path !== state.scratchPath) {
            await localGitMutationNodeAdapter.rmdir(path)
            return
          }
          state.wrapperRemovals += 1
          await localGitMutationNodeAdapter.rmdir(path)
          state.wrapperRemoved = true
          throw wrapperRemovalFailure
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '8', 54)
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      state.armed = true

      let caught: unknown
      try {
        await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } catch (error) {
        caught = error
      }

      expect(caught).toBe(primaryFailure)
      expect(caught).not.toBe(closeFailure)
      expect(caught).not.toBe(ownerRemovalFailure)
      expect(caught).not.toBe(wrapperRemovalFailure)
      expect(state).toMatchObject({
        injected: true,
        syncCalls: 1,
        closeCalls: 1,
        ownerLstats: 1,
        ownerRemovals: 1,
        wrapperLstats: 2,
        wrapperRemovals: 1,
        ownerRemoved: true,
        wrapperRemoved: true,
      })
      if (state.scratchPath === undefined || state.postCloseStat === undefined) {
        throw new Error('test retained no rolled-back scratch handle')
      }
      await expect(state.postCloseStat()).rejects.toThrow()
      await expect(stat(state.scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
        state: 'planning',
        revision: 2,
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('keeps a durable Stage retryable when its scratch owner is missing', async () => {
      const root = await repository()
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '9', 55)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const scratch = durable.effectPlan.scratch
      const ownerPath = join(scratch.path, 'owner')
      const retainedOwnerPath = `${ownerPath}.retained-missing`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const ownerBytes = await readFile(ownerPath)
      roots.push(retainedOwnerPath)
      await rename(ownerPath, retainedOwnerPath)

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })

      await expect(stat(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(retainedOwnerPath)).resolves.toEqual(ownerBytes)
      await expect(stat(scratch.path)).resolves.toBeDefined()
      await expect(stat(durable.effectPlan.pin.path)).resolves.toBeDefined()
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      await rename(retainedOwnerPath, ownerPath)
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('preserves both directories when the final scratch confirmation sees a replacement', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-scratch-final-confirmation-'))
      roots.push(holdingRoot)
      const ownedStash = join(holdingRoot, 'owned')
      const sentinel = Buffer.from('foreign final scratch confirmation\n', 'utf8')
      const state = {
        armed: false,
        ownerReadClosed: false,
        ownerConfirmed: false,
        injected: false,
        injectionCalls: 0,
        scratchPath: undefined as string | undefined,
        ownerPath: undefined as string | undefined,
        foreignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async open(path, flags, mode) {
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (!state.armed || path !== state.ownerPath || flags !== 'r') return handle
          return {
            ...handle,
            async close() {
              await handle.close()
              state.ownerReadClosed = true
            },
          }
        },
        async lstat(path) {
          if (state.armed && state.ownerReadClosed && path === state.ownerPath) {
            state.ownerConfirmed = true
          }
          if (state.armed && state.ownerConfirmed && !state.injected && path === state.scratchPath) {
            state.injected = true
            state.injectionCalls += 1
            await localGitMutationNodeAdapter.rename(path, ownedStash)
            await cp(ownedStash, path, { recursive: true })
            await writeFile(join(path, 'foreign-sentinel'), sentinel, { flag: 'wx', mode: 0o600 })
            const foreign = await localGitMutationNodeAdapter.lstat(path)
            state.foreignIdentity = { device: foreign.dev.toString(), inode: foreign.ino.toString() }
            return foreign
          }
          return await localGitMutationNodeAdapter.lstat(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'a', 56)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const scratch = durable.effectPlan.scratch
      const originalScratch = await stat(scratch.path, { bigint: true })
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      state.scratchPath = scratch.path
      state.ownerPath = join(scratch.path, 'owner')
      state.armed = true

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })

      expect(state).toMatchObject({
        ownerReadClosed: true,
        ownerConfirmed: true,
        injected: true,
        injectionCalls: 1,
      })
      const foreign = await stat(scratch.path, { bigint: true })
      expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).toEqual(state.foreignIdentity)
      expect(await readFile(join(scratch.path, 'foreign-sentinel'))).toEqual(sentinel)
      expect(await readFile(join(scratch.path, 'owner'))).toEqual(await readFile(join(ownedStash, 'owner')))
      expect(await readFile(join(scratch.path, 'payload', 'target.index'))).toEqual(
        await readFile(join(ownedStash, 'payload', 'target.index')),
      )
      const retained = await stat(ownedStash, { bigint: true })
      expect({ dev: retained.dev, ino: retained.ino }).toEqual({
        dev: originalScratch.dev,
        ino: originalScratch.ino,
      })
      await expect(stat(durable.effectPlan.pin.path)).resolves.toBeDefined()
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      state.armed = false
      await rm(scratch.path, { recursive: true, force: false })
      await rename(ownedStash, scratch.path)
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('keeps a durable Stage retryable when its scratch directory inspection fails', async () => {
      const root = await repository()
      const state = {
        armed: false,
        injected: false,
        injectionCalls: 0,
        scratchPath: undefined as string | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          if (state.armed && !state.injected && path === state.scratchPath) {
            state.injected = true
            state.injectionCalls += 1
            throw Object.assign(new Error('injected scratch directory lstat failure'), {
              code: 'EIO',
              errno: -5,
              syscall: 'lstat',
              path,
            })
          }
          return await localGitMutationNodeAdapter.lstat(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'b', 57)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const scratch = durable.effectPlan.scratch
      const ownerPath = join(scratch.path, 'owner')
      const scratchInfo = await stat(scratch.path, { bigint: true })
      const ownerInfo = await stat(ownerPath, { bigint: true })
      const ownerBytes = await readFile(ownerPath)
      const pinBytes = await readFile(durable.effectPlan.pin.path)
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      state.scratchPath = scratch.path
      state.armed = true

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })

      expect(state).toMatchObject({ injected: true, injectionCalls: 1 })
      expect(await stat(scratch.path, { bigint: true })).toMatchObject({
        dev: scratchInfo.dev,
        ino: scratchInfo.ino,
      })
      expect(await stat(ownerPath, { bigint: true })).toMatchObject({
        dev: ownerInfo.dev,
        ino: ownerInfo.ino,
      })
      expect(await readFile(ownerPath)).toEqual(ownerBytes)
      expect(await readFile(durable.effectPlan.pin.path)).toEqual(pinBytes)
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      state.armed = false
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('keeps a durable Stage retryable when scratch owner metadata drifts after its bounded read', async () => {
      const root = await repository()
      const state = {
        armed: false,
        injected: false,
        injectionCalls: 0,
        ownerPath: undefined as string | undefined,
        before: undefined as { readonly device: string; readonly inode: string; readonly mtimeNs: bigint } | undefined,
        after: undefined as { readonly device: string; readonly inode: string; readonly mtimeNs: bigint } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async open(path, flags, mode) {
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (!state.armed || state.injected || path !== state.ownerPath || flags !== 'r') return handle
          return {
            ...handle,
            async close() {
              await handle.close()
              if (state.injected) return
              state.injected = true
              state.injectionCalls += 1
              const before = await stat(path, { bigint: true })
              state.before = {
                device: before.dev.toString(),
                inode: before.ino.toString(),
                mtimeNs: before.mtimeNs,
              }
              await utimes(path, new Date(946_684_800_000), new Date(946_684_801_000))
              const after = await stat(path, { bigint: true })
              state.after = {
                device: after.dev.toString(),
                inode: after.ino.toString(),
                mtimeNs: after.mtimeNs,
              }
            },
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'c', 58)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const scratch = durable.effectPlan.scratch
      const ownerPath = join(scratch.path, 'owner')
      const ownerBytes = await readFile(ownerPath)
      const pinBytes = await readFile(durable.effectPlan.pin.path)
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      state.ownerPath = ownerPath
      state.armed = true

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })

      expect(state).toMatchObject({ injected: true, injectionCalls: 1 })
      expect(state.before).toBeDefined()
      expect(state.after).toBeDefined()
      expect({ device: state.after?.device, inode: state.after?.inode }).toEqual({
        device: state.before?.device,
        inode: state.before?.inode,
      })
      expect(state.after?.mtimeNs).not.toBe(state.before?.mtimeNs)
      expect(await readFile(ownerPath)).toEqual(ownerBytes)
      expect(await readFile(durable.effectPlan.pin.path)).toEqual(pinBytes)
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      state.armed = false
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('preserves a stable same-inode scratch owner with the wrong marker', async () => {
      const root = await repository()
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'd', 59)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const scratch = durable.effectPlan.scratch
      const ownerPath = join(scratch.path, 'owner')
      const ownerBytes = await readFile(ownerPath)
      const wrongMarker = Buffer.from(ownerBytes)
      wrongMarker[0] = (wrongMarker[0] ?? 0) ^ 1
      const ownerInfo = await stat(ownerPath, { bigint: true })
      const pinBytes = await readFile(durable.effectPlan.pin.path)
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      await writeFile(ownerPath, wrongMarker)

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })

      const retainedOwner = await stat(ownerPath, { bigint: true })
      expect({ dev: retainedOwner.dev, ino: retainedOwner.ino, size: retainedOwner.size }).toEqual({
        dev: ownerInfo.dev,
        ino: ownerInfo.ino,
        size: ownerInfo.size,
      })
      expect(await readFile(ownerPath)).toEqual(wrongMarker)
      expect(await readFile(durable.effectPlan.pin.path)).toEqual(pinBytes)
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      await writeFile(ownerPath, ownerBytes)
      const restoredOwner = await stat(ownerPath, { bigint: true })
      expect({ dev: restoredOwner.dev, ino: restoredOwner.ino }).toEqual({
        dev: ownerInfo.dev,
        ino: ownerInfo.ino,
      })
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('preserves both worlds when the final quarantined-directory confirmation drifts', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-quarantine-final-confirmation-'))
      roots.push(holdingRoot)
      const ownedStash = join(holdingRoot, 'owned')
      const foreignStash = join(holdingRoot, 'foreign')
      const sentinel = Buffer.from('foreign quarantine final confirmation\n', 'utf8')
      const state = {
        armed: false,
        internalReadClosed: false,
        internalConfirmed: false,
        injected: false,
        injectionCalls: 0,
        quarantinePath: undefined as string | undefined,
        internalOwnerPath: undefined as string | undefined,
        foreignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
        foreignOwnerIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async open(path, flags, mode) {
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (!state.armed || path !== state.internalOwnerPath || flags !== 'r') return handle
          return {
            ...handle,
            async close() {
              await handle.close()
              state.internalReadClosed = true
            },
          }
        },
        async lstat(path) {
          if (state.armed && state.internalReadClosed && path === state.internalOwnerPath) {
            state.internalConfirmed = true
          }
          if (state.armed && state.internalConfirmed && !state.injected && path === state.quarantinePath) {
            state.injected = true
            state.injectionCalls += 1
            await localGitMutationNodeAdapter.rename(path, ownedStash)
            await mkdir(path, { mode: 0o700 })
            const foreignOwnerPath = join(path, 'owner')
            await writeFile(foreignOwnerPath, sentinel, { flag: 'wx', mode: 0o600 })
            const foreign = await localGitMutationNodeAdapter.lstat(path)
            const foreignOwner = await localGitMutationNodeAdapter.lstat(foreignOwnerPath)
            state.foreignIdentity = { device: foreign.dev.toString(), inode: foreign.ino.toString() }
            state.foreignOwnerIdentity = {
              device: foreignOwner.dev.toString(),
              inode: foreignOwner.ino.toString(),
            }
            return foreign
          }
          return await localGitMutationNodeAdapter.lstat(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'e', 60)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const scratch = durable.effectPlan.scratch
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      state.quarantinePath = quarantinePath
      state.internalOwnerPath = join(quarantinePath, 'owner')
      roots.push(quarantinePath, witnessPath)
      state.armed = true

      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

      expect(state).toMatchObject({
        internalReadClosed: true,
        internalConfirmed: true,
        injected: true,
        injectionCalls: 1,
      })
      const restoredForeign = await stat(scratch.path, { bigint: true })
      expect({ device: restoredForeign.dev.toString(), inode: restoredForeign.ino.toString() }).toEqual(
        state.foreignIdentity,
      )
      const restoredForeignOwner = await stat(join(scratch.path, 'owner'), { bigint: true })
      expect({
        device: restoredForeignOwner.dev.toString(),
        inode: restoredForeignOwner.ino.toString(),
      }).toEqual(state.foreignOwnerIdentity)
      expect(await readFile(join(scratch.path, 'owner'))).toEqual(sentinel)
      const retainedOwned = await stat(ownedStash, { bigint: true })
      expect({ device: retainedOwned.dev.toString(), inode: retainedOwned.ino.toString() }).toEqual(
        scratch.identity,
      )
      await expect(stat(join(ownedStash, 'owner'))).resolves.toBeDefined()
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      state.armed = false
      await rename(scratch.path, foreignStash)
      await rename(ownedStash, scratch.path)
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(foreignStash, 'owner'))).toEqual(sentinel)
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('restores a promoted scratch when its witness confirmation is unavailable', async () => {
      const root = await repository()
      const state = {
        trackCleanup: true,
        promoted: false,
        injected: false,
        promotions: 0,
        witnessFailures: 0,
        ownerRollbacks: 0,
        wrapperRollbacks: 0,
        scratchPath: undefined as string | undefined,
        quarantinePath: undefined as string | undefined,
        witnessPath: undefined as string | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          if (state.trackCleanup && state.promoted && !state.injected && path === state.witnessPath) {
            state.injected = true
            state.witnessFailures += 1
            throw Object.assign(new Error('injected promoted scratch witness lstat failure'), {
              code: 'EIO',
              errno: -5,
              syscall: 'lstat',
              path,
            })
          }
          return await localGitMutationNodeAdapter.lstat(path)
        },
        async rename(from, to) {
          await localGitMutationNodeAdapter.rename(from, to)
          if (!state.trackCleanup || state.quarantinePath === undefined
            || state.witnessPath === undefined || state.scratchPath === undefined) return
          if (from === join(state.quarantinePath, 'owner') && to === state.witnessPath) {
            state.promoted = true
            state.promotions += 1
          } else if (from === state.witnessPath && to === join(state.quarantinePath, 'owner')) {
            state.ownerRollbacks += 1
          } else if (from === state.quarantinePath && to === state.scratchPath) {
            state.wrapperRollbacks += 1
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '0', 62)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      const ownerPath = join(scratch.path, 'owner')
      const ownerBytes = await readFile(ownerPath)
      const payloadIndex = await readFile(join(scratch.path, 'payload', 'target.index'))
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalCachedDiff = await gitText(root, 'diff', '--cached', '--name-only')
      const originalWorktreeDiff = await gitText(root, 'diff', '--name-only')
      state.scratchPath = scratch.path
      state.quarantinePath = quarantinePath
      state.witnessPath = witnessPath
      roots.push(quarantinePath, witnessPath)
      const frozenWorld: FrozenGitMutationWorld = {
        root,
        pinPath: durable.effectPlan.pin.path,
        indexPath,
        lockPath,
        indexBytes: originalIndex,
        indexIdentity: {
          device: originalIndexInfo.dev.toString(),
          inode: originalIndexInfo.ino.toString(),
          mode: originalIndexInfo.mode.toString(),
        },
        parent,
        cachedDiff: originalCachedDiff,
        worktreeDiff: originalWorktreeDiff,
      }

      const canceled = await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )
      expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

      expect({
        promotions: state.promotions,
        witnessFailures: state.witnessFailures,
        ownerRollbacks: state.ownerRollbacks,
        wrapperRollbacks: state.wrapperRollbacks,
      }).toEqual({ promotions: 1, witnessFailures: 1, ownerRollbacks: 1, wrapperRollbacks: 1 })
      const restoredScratch = await stat(scratch.path, { bigint: true })
      expect({ device: restoredScratch.dev.toString(), inode: restoredScratch.ino.toString() }).toEqual(
        scratch.identity,
      )
      const restoredOwner = await stat(ownerPath, { bigint: true })
      expect({ device: restoredOwner.dev.toString(), inode: restoredOwner.ino.toString() }).toEqual(
        scratch.ownerIdentity,
      )
      await expect(readFile(ownerPath)).resolves.toEqual(ownerBytes)
      await expect(readFile(join(scratch.path, 'payload', 'target.index'))).resolves.toEqual(payloadIndex)
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expectFrozenGitMutationWorld(frozenWorld)

      state.trackCleanup = false
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toEqual(canceled)
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expectFrozenGitMutationWorld(frozenWorld)
    }, 90_000)

    it('preserves an empty foreign quarantine after payload removal', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-empty-foreign-quarantine-'))
      roots.push(holdingRoot)
      const ownedStash = join(holdingRoot, 'owned')
      const foreignStash = join(holdingRoot, 'foreign')
      const state = {
        armed: false,
        injected: false,
        payloadRemovals: 0,
        quarantineRmdirAttempts: 0,
        witnessRemovals: 0,
        quarantinePath: undefined as string | undefined,
        witnessPath: undefined as string | undefined,
        foreignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async rm(path, options) {
          if (state.armed && path === state.witnessPath && options.recursive !== true) {
            state.witnessRemovals += 1
          }
          await localGitMutationNodeAdapter.rm(path, options)
        },
        async rmdir(path) {
          if (state.armed && !state.injected && state.quarantinePath !== undefined
            && path === join(state.quarantinePath, 'payload')) {
            await localGitMutationNodeAdapter.rmdir(path)
            state.payloadRemovals += 1
            await localGitMutationNodeAdapter.rename(state.quarantinePath, ownedStash)
            expect(await readdir(ownedStash)).toEqual([])
            await mkdir(state.quarantinePath, { mode: 0o700 })
            const foreign = await stat(state.quarantinePath, { bigint: true })
            state.foreignIdentity = {
              device: foreign.dev.toString(),
              inode: foreign.ino.toString(),
            }
            state.injected = true
            return
          }
          if (state.armed && path === state.quarantinePath) state.quarantineRmdirAttempts += 1
          await localGitMutationNodeAdapter.rmdir(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '1', 63)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      const ownerBytes = await readFile(join(scratch.path, 'owner'))
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalCachedDiff = await gitText(root, 'diff', '--cached', '--name-only')
      const originalWorktreeDiff = await gitText(root, 'diff', '--name-only')
      state.quarantinePath = quarantinePath
      state.witnessPath = witnessPath
      roots.push(quarantinePath, witnessPath)
      state.armed = true
      const frozenWorld: FrozenGitMutationWorld = {
        root,
        pinPath: durable.effectPlan.pin.path,
        indexPath,
        lockPath,
        indexBytes: originalIndex,
        indexIdentity: {
          device: originalIndexInfo.dev.toString(),
          inode: originalIndexInfo.ino.toString(),
          mode: originalIndexInfo.mode.toString(),
        },
        parent,
        cachedDiff: originalCachedDiff,
        worktreeDiff: originalWorktreeDiff,
      }

      const canceled = await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )
      expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

      expect(state).toMatchObject({
        injected: true,
        payloadRemovals: 1,
        quarantineRmdirAttempts: 0,
        witnessRemovals: 0,
      })
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      const foreign = await stat(quarantinePath, { bigint: true })
      expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).toEqual(state.foreignIdentity)
      expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).not.toEqual(scratch.identity)
      expect(await readdir(quarantinePath)).toEqual([])
      const retainedOwned = await stat(ownedStash, { bigint: true })
      expect({ device: retainedOwned.dev.toString(), inode: retainedOwned.ino.toString() }).toEqual(scratch.identity)
      expect(await readdir(ownedStash)).toEqual([])
      const witness = await stat(witnessPath, { bigint: true })
      expect({ device: witness.dev.toString(), inode: witness.ino.toString() }).toEqual(scratch.ownerIdentity)
      await expect(readFile(witnessPath)).resolves.toEqual(ownerBytes)
      await expectFrozenGitMutationWorld(frozenWorld)

      state.armed = false
      await rename(quarantinePath, foreignStash)
      await rename(ownedStash, quarantinePath)
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toEqual(canceled)
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const retainedForeign = await stat(foreignStash, { bigint: true })
      expect({ device: retainedForeign.dev.toString(), inode: retainedForeign.ino.toString() }).toEqual(
        state.foreignIdentity,
      )
      expect(await readdir(foreignStash)).toEqual([])
      await expectFrozenGitMutationWorld(frozenWorld)
    }, 90_000)

    it('retains an internally owned quarantine when its external witness is unavailable', async () => {
      const root = await repository()
      const state = {
        armed: false,
        injected: false,
        injectionCalls: 0,
        witnessPath: undefined as string | undefined,
        replayArmed: false,
        replayRemovals: [] as Array<{
          readonly path: string
          readonly recursive: boolean
          readonly force: boolean | undefined
        }>,
        replayUnlinks: [] as string[],
        replayRmdirs: [] as string[],
        replayRenames: [] as Array<{ readonly from: string; readonly to: string }>,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          if (state.armed && !state.injected && path === state.witnessPath) {
            state.injected = true
            state.injectionCalls += 1
            throw Object.assign(new Error('injected quarantine witness lstat failure'), {
              code: 'EIO',
              errno: -5,
              syscall: 'lstat',
              path,
            })
          }
          return await localGitMutationNodeAdapter.lstat(path)
        },
        async rename(from, to) {
          if (state.replayArmed) state.replayRenames.push({ from, to })
          await localGitMutationNodeAdapter.rename(from, to)
        },
        async rm(path, options) {
          if (state.replayArmed) {
            state.replayRemovals.push({
              path,
              recursive: options.recursive === true,
              force: options.force,
            })
          }
          await localGitMutationNodeAdapter.rm(path, options)
        },
        async unlink(path) {
          if (state.replayArmed) state.replayUnlinks.push(path)
          await localGitMutationNodeAdapter.unlink(path)
        },
        async rmdir(path) {
          if (state.replayArmed) state.replayRmdirs.push(path)
          await localGitMutationNodeAdapter.rmdir(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'f', 61)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const scratch = durable.effectPlan.scratch
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      const ownerBytes = await readFile(join(scratch.path, 'owner'))
      const payloadIndex = await readFile(join(scratch.path, 'payload', 'target.index'))
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      roots.push(quarantinePath, witnessPath)
      state.witnessPath = witnessPath
      await rename(scratch.path, quarantinePath)
      state.armed = true

      const canceled = await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )
      expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

      expect(state).toMatchObject({ injected: true, injectionCalls: 1 })
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      const retained = await stat(quarantinePath, { bigint: true })
      expect({ device: retained.dev.toString(), inode: retained.ino.toString() }).toEqual(scratch.identity)
      expect(await readFile(join(quarantinePath, 'owner'))).toEqual(ownerBytes)
      expect(await readFile(join(quarantinePath, 'payload', 'target.index'))).toEqual(payloadIndex)
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await stat(indexPath, { bigint: true })).toMatchObject({
        dev: originalIndexInfo.dev,
        ino: originalIndexInfo.ino,
        mode: originalIndexInfo.mode,
      })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      state.armed = false
      state.replayArmed = true
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toEqual(canceled)
      expect(state.replayRenames).toEqual([{
        from: join(quarantinePath, 'owner'),
        to: witnessPath,
      }])
      expect(state.replayRemovals).toEqual([
        { path: witnessPath, recursive: false, force: false },
      ])
      expect(state.replayUnlinks).toEqual(expect.arrayContaining([
        join(quarantinePath, 'payload', 'objects', 'info', 'alternates'),
        join(quarantinePath, 'payload', 'target.index'),
      ]))
      expect(state.replayRmdirs).toEqual(expect.arrayContaining([
        join(quarantinePath, 'payload', 'hooks'),
        join(quarantinePath, 'payload', 'objects', 'info'),
        join(quarantinePath, 'payload', 'objects'),
        join(quarantinePath, 'payload'),
        quarantinePath,
      ]))
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await stat(indexPath, { bigint: true })).toMatchObject({
        dev: originalIndexInfo.dev,
        ino: originalIndexInfo.ino,
        mode: originalIndexInfo.mode,
      })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      expect(await gitText(root, 'diff', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('restores a double-marked quarantine as foreign evidence', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-double-marked-quarantine-'))
      roots.push(holdingRoot)
      const ownedStash = join(holdingRoot, 'owned')
      const foreignStash = join(holdingRoot, 'foreign')
      const sentinel = Buffer.from('foreign double-marked quarantine\n', 'utf8')
      const tracked = scratchRootTrackingNodeAdapter()
      const state = {
        active: false,
        outerRenamed: false,
        foreignInstalled: false,
        doubleMarked: false,
        restoreRenames: 0,
        scratchPath: undefined as string | undefined,
        quarantinePath: undefined as string | undefined,
        witnessPath: undefined as string | undefined,
        foreignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          if (state.active && state.outerRenamed && !state.foreignInstalled
            && path === state.quarantinePath) {
            await tracked.rename(path, ownedStash)
            await mkdir(path, { mode: 0o700 })
            await writeFile(join(path, 'sentinel'), sentinel, { flag: 'wx', mode: 0o600 })
            const foreign = await tracked.lstat(path)
            state.foreignIdentity = {
              device: foreign.dev.toString(),
              inode: foreign.ino.toString(),
            }
            state.foreignInstalled = true
            return foreign
          }
          if (state.active && state.foreignInstalled && !state.doubleMarked
            && path === state.scratchPath && state.quarantinePath !== undefined
            && state.witnessPath !== undefined) {
            await tracked.rename(state.quarantinePath, foreignStash)
            await tracked.rename(ownedStash, state.quarantinePath)
            await tracked.link(join(state.quarantinePath, 'owner'), state.witnessPath)
            state.doubleMarked = true
          }
          return await tracked.lstat(path)
        },
        async rename(from, to) {
          await tracked.rename(from, to)
          if (!state.active) return
          if (from === state.scratchPath && to === state.quarantinePath) {
            state.outerRenamed = true
          } else if (from === state.quarantinePath && to === state.scratchPath) {
            state.restoreRenames += 1
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '2', 64)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      const ownerPath = join(scratch.path, 'owner')
      const ownerBytes = await readFile(ownerPath)
      const payloadIndex = await readFile(join(scratch.path, 'payload', 'target.index'))
      const indexPath = join(root, '.git', 'index')
      const frozenWorld: FrozenGitMutationWorld = {
        ...await captureUnpublishedGitMutationWorld(root, indexPath, `${indexPath}.lock`),
        pinPath: durable.effectPlan.pin.path,
      }
      state.scratchPath = scratch.path
      state.quarantinePath = quarantinePath
      state.witnessPath = witnessPath
      state.active = true

      const canceled = await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )
      expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

      expect(state).toMatchObject({
        outerRenamed: true,
        foreignInstalled: true,
        doubleMarked: true,
        restoreRenames: 1,
      })
      const restoredScratch = await stat(scratch.path, { bigint: true })
      expect({ device: restoredScratch.dev.toString(), inode: restoredScratch.ino.toString() }).toEqual(
        scratch.identity,
      )
      const restoredOwner = await stat(ownerPath, { bigint: true })
      expect({ device: restoredOwner.dev.toString(), inode: restoredOwner.ino.toString() }).toEqual(
        scratch.ownerIdentity,
      )
      await expect(readFile(ownerPath)).resolves.toEqual(ownerBytes)
      await expect(readFile(join(scratch.path, 'payload', 'target.index'))).resolves.toEqual(payloadIndex)
      const witness = await stat(witnessPath, { bigint: true })
      expect({ device: witness.dev.toString(), inode: witness.ino.toString() }).toEqual(scratch.ownerIdentity)
      await expect(readFile(witnessPath)).resolves.toEqual(ownerBytes)
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      const foreign = await stat(foreignStash, { bigint: true })
      expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).toEqual(state.foreignIdentity)
      await expect(readFile(join(foreignStash, 'sentinel'))).resolves.toEqual(sentinel)
      await expectFrozenGitMutationWorld(frozenWorld)

      state.active = false
      await unlink(witnessPath)
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toEqual(canceled)
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(foreignStash, 'sentinel'))).resolves.toEqual(sentinel)
      await expectFrozenGitMutationWorld(frozenWorld)
    }, 90_000)

    it('retains external evidence when real non-empty rmdir cannot restore over a reappeared original', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-rmdir-reappeared-original-'))
      roots.push(holdingRoot)
      const foreignStash = join(holdingRoot, 'foreign')
      const foreignSentinel = Buffer.from('foreign reappeared original\n', 'utf8')
      const blocker = Buffer.from('real non-empty quarantine blocker\n', 'utf8')
      const tracked = scratchRootTrackingNodeAdapter()
      const state = {
        active: false,
        injected: false,
        rmdirAttempts: 0,
        originalChecksAfterFailure: 0,
        witnessRemovals: 0,
        rmdirFailure: undefined as unknown,
        scratchPath: undefined as string | undefined,
        quarantinePath: undefined as string | undefined,
        witnessPath: undefined as string | undefined,
        foreignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          if (state.active && state.rmdirFailure !== undefined && path === state.scratchPath) {
            state.originalChecksAfterFailure += 1
          }
          return await tracked.lstat(path)
        },
        async rm(path, options) {
          if (state.active && path === state.witnessPath && options.recursive !== true) {
            state.witnessRemovals += 1
          }
          await tracked.rm(path, options)
        },
        async rmdir(path) {
          if (!state.active || state.injected || path !== state.quarantinePath
            || state.scratchPath === undefined) {
            await tracked.rmdir(path)
            return
          }
          state.injected = true
          state.rmdirAttempts += 1
          await mkdir(state.scratchPath, { mode: 0o700 })
          await writeFile(join(state.scratchPath, 'sentinel'), foreignSentinel, {
            flag: 'wx',
            mode: 0o600,
          })
          const foreign = await stat(state.scratchPath, { bigint: true })
          state.foreignIdentity = {
            device: foreign.dev.toString(),
            inode: foreign.ino.toString(),
          }
          await writeFile(join(path, 'blocker'), blocker, { flag: 'wx', mode: 0o600 })
          try {
            await tracked.rmdir(path)
          } catch (error) {
            state.rmdirFailure = error
            throw error
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '3', 65)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      const blockerPath = join(quarantinePath, 'blocker')
      const ownerBytes = await readFile(join(scratch.path, 'owner'))
      const indexPath = join(root, '.git', 'index')
      const frozenWorld: FrozenGitMutationWorld = {
        ...await captureUnpublishedGitMutationWorld(root, indexPath, `${indexPath}.lock`),
        pinPath: durable.effectPlan.pin.path,
      }
      state.scratchPath = scratch.path
      state.quarantinePath = quarantinePath
      state.witnessPath = witnessPath
      state.active = true

      const canceled = await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )
      expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })

      expect(state).toMatchObject({
        injected: true,
        rmdirAttempts: 1,
        originalChecksAfterFailure: 1,
        witnessRemovals: 0,
      })
      expect(state.rmdirFailure).toBeDefined()
      const retainedQuarantine = await stat(quarantinePath, { bigint: true })
      expect({
        device: retainedQuarantine.dev.toString(),
        inode: retainedQuarantine.ino.toString(),
      }).toEqual(scratch.identity)
      await expect(stat(join(quarantinePath, 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
      const witness = await stat(witnessPath, { bigint: true })
      expect({ device: witness.dev.toString(), inode: witness.ino.toString() }).toEqual(scratch.ownerIdentity)
      await expect(readFile(witnessPath)).resolves.toEqual(ownerBytes)
      await expect(readFile(blockerPath)).resolves.toEqual(blocker)
      const foreign = await stat(scratch.path, { bigint: true })
      expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).toEqual(state.foreignIdentity)
      await expect(readFile(join(scratch.path, 'sentinel'))).resolves.toEqual(foreignSentinel)
      await expectFrozenGitMutationWorld(frozenWorld)

      state.active = false
      await rename(scratch.path, foreignStash)
      await unlink(blockerPath)
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toEqual(canceled)
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(foreignStash, 'sentinel'))).resolves.toEqual(foreignSentinel)
      await expectFrozenGitMutationWorld(frozenWorld)
    }, 90_000)

    it('preserves a real foreign directory that replaces an owned Stage payload', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-foreign-payload-'))
      roots.push(holdingRoot)
      const ownedPayloadStash = join(holdingRoot, 'owned-payload')
      const foreignPayloadStash = join(holdingRoot, 'foreign-payload')
      const sentinel = Buffer.from('foreign payload directory\n', 'utf8')
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '5', 67)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const payloadPath = join(scratch.path, 'payload')
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      const ownedPayload = await lstat(payloadPath, { bigint: true })
      expect(ownedPayload.isDirectory()).toBe(true)
      expect(ownedPayload.isSymbolicLink()).toBe(false)
      expect({ device: ownedPayload.dev.toString(), inode: ownedPayload.ino.toString() }).toEqual(
        scratch.payloadIdentity,
      )
      const legacyScratch = {
        path: scratch.path,
        markerDigest: scratch.markerDigest,
        identity: scratch.identity,
        ownerIdentity: scratch.ownerIdentity,
      }
      expect(sakiHostExecutionDomainSpec.tables.operations.valueSchema.safeParse({
        ...durable,
        effectPlan: { ...durable.effectPlan, scratch: legacyScratch },
      }).success).toBe(false)
      const indexPath = join(root, '.git', 'index')
      const frozenWorld: FrozenGitMutationWorld = {
        ...await captureUnpublishedGitMutationWorld(root, indexPath, `${indexPath}.lock`),
        pinPath: durable.effectPlan.pin.path,
      }
      await rename(payloadPath, ownedPayloadStash)
      await mkdir(payloadPath, { mode: 0o700 })
      await writeFile(join(payloadPath, 'sentinel'), sentinel, { flag: 'wx', mode: 0o600 })
      const foreignPayload = await stat(payloadPath, { bigint: true })
      expect({ device: foreignPayload.dev, inode: foreignPayload.ino }).not.toEqual({
        device: ownedPayload.dev,
        inode: ownedPayload.ino,
      })
      const canceled = await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )

      expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
      const retainedScratch = await stat(scratch.path, { bigint: true })
      expect({ device: retainedScratch.dev.toString(), inode: retainedScratch.ino.toString() }).toEqual(
        scratch.identity,
      )
      const retainedPayload = await stat(payloadPath, { bigint: true })
      expect({ device: retainedPayload.dev, inode: retainedPayload.ino }).toEqual({
        device: foreignPayload.dev,
        inode: foreignPayload.ino,
      })
      await expect(readFile(join(payloadPath, 'sentinel'))).resolves.toEqual(sentinel)
      const retainedOwnedPayload = await stat(ownedPayloadStash, { bigint: true })
      expect({ device: retainedOwnedPayload.dev, inode: retainedOwnedPayload.ino }).toEqual({
        device: ownedPayload.dev,
        inode: ownedPayload.ino,
      })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expectFrozenGitMutationWorld(frozenWorld)

      await rename(payloadPath, foreignPayloadStash)
      await rename(ownedPayloadStash, payloadPath)
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toEqual(canceled)
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(foreignPayloadStash, 'sentinel'))).resolves.toEqual(sentinel)
      await expectFrozenGitMutationWorld(frozenWorld)
    }, 90_000)

    it('preserves a real file that replaces an owned Stage payload', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-file-payload-'))
      roots.push(holdingRoot)
      const ownedPayloadStash = join(holdingRoot, 'owned-payload')
      const replacement = Buffer.from('foreign payload file\n', 'utf8')
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '8', 70)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const payloadPath = join(scratch.path, 'payload')
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      for (const cleanupPath of [quarantinePath, witnessPath]) {
        if (!roots.includes(cleanupPath)) roots.push(cleanupPath)
      }
      const indexPath = join(root, '.git', 'index')
      const frozenWorld: FrozenGitMutationWorld = {
        ...await captureUnpublishedGitMutationWorld(root, indexPath, `${indexPath}.lock`),
        pinPath: durable.effectPlan.pin.path,
      }
      await rename(payloadPath, ownedPayloadStash)
      await writeFile(payloadPath, replacement, { flag: 'wx', mode: 0o600 })

      const canceled = await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )

      expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
      const retainedScratch = await stat(scratch.path, { bigint: true })
      expect({ device: retainedScratch.dev.toString(), inode: retainedScratch.ino.toString() }).toEqual(
        scratch.identity,
      )
      const retainedPayload = await lstat(payloadPath)
      expect(retainedPayload.isFile()).toBe(true)
      expect(retainedPayload.isSymbolicLink()).toBe(false)
      await expect(readFile(payloadPath)).resolves.toEqual(replacement)
      const retainedOwnedPayload = await stat(ownedPayloadStash, { bigint: true })
      expect({ device: retainedOwnedPayload.dev.toString(), inode: retainedOwnedPayload.ino.toString() }).toEqual(
        scratch.payloadIdentity,
      )
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expectFrozenGitMutationWorld(frozenWorld)

      await unlink(payloadPath)
      await rename(ownedPayloadStash, payloadPath)
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toEqual(canceled)
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expectFrozenGitMutationWorld(frozenWorld)
    }, 90_000)

    it('preserves a real directory link that replaces an owned Stage payload', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-linked-payload-'))
      roots.push(holdingRoot)
      const ownedPayloadStash = join(holdingRoot, 'owned-payload')
      const targetPath = join(holdingRoot, 'link-target')
      const targetSentinelPath = join(targetPath, 'sentinel')
      const targetSentinel = Buffer.from('directory link target\n', 'utf8')
      await mkdir(targetPath, { mode: 0o700 })
      await writeFile(targetSentinelPath, targetSentinel, { flag: 'wx', mode: 0o600 })
      const execution = await provider(root)
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '6', 68)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const payloadPath = join(scratch.path, 'payload')
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      for (const cleanupPath of [quarantinePath, witnessPath]) {
        if (!roots.includes(cleanupPath)) roots.push(cleanupPath)
      }
      const indexPath = join(root, '.git', 'index')
      const frozenWorld: FrozenGitMutationWorld = {
        ...await captureUnpublishedGitMutationWorld(root, indexPath, `${indexPath}.lock`),
        pinPath: durable.effectPlan.pin.path,
      }
      await rename(payloadPath, ownedPayloadStash)
      try {
        await symlink(targetPath, payloadPath, process.platform === 'win32' ? 'junction' : 'dir')
        const replacement = await lstat(payloadPath, { bigint: true })
        expect(replacement.isSymbolicLink()).toBe(true)

        const canceled = await execution.cancelOperation(
          prepared.preparation.operation,
          'source-canceled',
          signal,
        )

        expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
        const retainedScratch = await stat(scratch.path, { bigint: true })
        expect({ device: retainedScratch.dev.toString(), inode: retainedScratch.ino.toString() }).toEqual(
          scratch.identity,
        )
        const retainedLink = await lstat(payloadPath, { bigint: true })
        expect(retainedLink.isSymbolicLink()).toBe(true)
        await expect(readFile(targetSentinelPath)).resolves.toEqual(targetSentinel)
        const retainedOwnedPayload = await stat(ownedPayloadStash, { bigint: true })
        expect({ device: retainedOwnedPayload.dev.toString(), inode: retainedOwnedPayload.ino.toString() }).toEqual(
          scratch.payloadIdentity,
        )
        await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expectFrozenGitMutationWorld(frozenWorld)

        await unlink(payloadPath)
        await rename(ownedPayloadStash, payloadPath)
        expect(await execution.inspectOperation(
          prepared.preparation.operation,
          signal,
        )).toEqual(canceled)
        await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(targetSentinelPath)).resolves.toEqual(targetSentinel)
        await expectFrozenGitMutationWorld(frozenWorld)
      } finally {
        await unlinkTestSymbolicLink(payloadPath)
        await unlinkTestSymbolicLink(join(quarantinePath, 'payload'))
      }
    }, 90_000)

    it('does not enter a directory link that replaces an owned payload after enumeration', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-enumerated-payload-'))
      roots.push(holdingRoot)
      const ownedPayloadStash = join(holdingRoot, 'owned-payload')
      const targetPath = join(holdingRoot, 'link-target')
      const targetHooksPath = join(targetPath, 'hooks')
      const targetObjectsPath = join(targetPath, 'objects')
      const targetIndexPath = join(targetPath, 'target.index')
      const targetSentinel = Buffer.from('enumeration race target\n', 'utf8')
      await mkdir(targetHooksPath, { recursive: true, mode: 0o700 })
      await mkdir(targetObjectsPath, { mode: 0o700 })
      await writeFile(join(targetHooksPath, 'sentinel'), targetSentinel, { flag: 'wx', mode: 0o600 })
      await writeFile(join(targetObjectsPath, 'sentinel'), targetSentinel, { flag: 'wx', mode: 0o600 })
      await writeFile(targetIndexPath, targetSentinel, { flag: 'wx', mode: 0o600 })
      const tracked = scratchRootTrackingNodeAdapter()
      const state = {
        active: false,
        injected: false,
        quarantinePayloadPath: undefined as string | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async readdir(path) {
          const entries = await tracked.readdir(path)
          if (state.active && !state.injected && path === state.quarantinePayloadPath) {
            state.injected = true
            await tracked.rename(path, ownedPayloadStash)
            await symlink(targetPath, path, process.platform === 'win32' ? 'junction' : 'dir')
          }
          return entries
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '9', 71)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const payloadPath = join(scratch.path, 'payload')
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const quarantinePayloadPath = join(quarantinePath, 'payload')
      const witnessPath = `${quarantinePath}.owner`
      for (const cleanupPath of [quarantinePath, witnessPath]) {
        if (!roots.includes(cleanupPath)) roots.push(cleanupPath)
      }
      const indexPath = join(root, '.git', 'index')
      const frozenWorld: FrozenGitMutationWorld = {
        ...await captureUnpublishedGitMutationWorld(root, indexPath, `${indexPath}.lock`),
        pinPath: durable.effectPlan.pin.path,
      }
      state.quarantinePayloadPath = quarantinePayloadPath
      state.active = true
      try {
        const canceled = await execution.cancelOperation(
          prepared.preparation.operation,
          'source-canceled',
          signal,
        )

        expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
        expect(state.injected).toBe(true)
        const retainedScratch = await stat(scratch.path, { bigint: true })
        expect({ device: retainedScratch.dev.toString(), inode: retainedScratch.ino.toString() }).toEqual(
          scratch.identity,
        )
        const retainedLink = await lstat(payloadPath)
        expect(retainedLink.isSymbolicLink()).toBe(true)
        const retainedOwnedPayload = await stat(ownedPayloadStash, { bigint: true })
        expect({ device: retainedOwnedPayload.dev.toString(), inode: retainedOwnedPayload.ino.toString() }).toEqual(
          scratch.payloadIdentity,
        )
        await expect(readFile(join(targetHooksPath, 'sentinel'))).resolves.toEqual(targetSentinel)
        await expect(readFile(join(targetObjectsPath, 'sentinel'))).resolves.toEqual(targetSentinel)
        await expect(readFile(targetIndexPath)).resolves.toEqual(targetSentinel)
        await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expectFrozenGitMutationWorld(frozenWorld)

        await unlink(payloadPath)
        await rename(ownedPayloadStash, payloadPath)
        state.active = false
        expect(await execution.inspectOperation(
          prepared.preparation.operation,
          signal,
        )).toEqual(canceled)
        await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(join(targetHooksPath, 'sentinel'))).resolves.toEqual(targetSentinel)
        await expect(readFile(join(targetObjectsPath, 'sentinel'))).resolves.toEqual(targetSentinel)
        await expect(readFile(targetIndexPath)).resolves.toEqual(targetSentinel)
        await expectFrozenGitMutationWorld(frozenWorld)
      } finally {
        state.active = false
        await unlinkTestSymbolicLink(payloadPath)
        await unlinkTestSymbolicLink(quarantinePayloadPath)
      }
    }, 90_000)

    it('replays a real owned payload after non-empty failure and rmdir acknowledgement loss', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-owned-payload-replay-'))
      roots.push(holdingRoot)
      const targetPath = join(holdingRoot, 'link-target')
      const targetSentinelPath = join(targetPath, 'sentinel')
      const targetSentinel = Buffer.from('owned payload link target\n', 'utf8')
      const blocker = Buffer.from('real payload rmdir blocker\n', 'utf8')
      await mkdir(targetPath, { mode: 0o700 })
      await writeFile(targetSentinelPath, targetSentinel, { flag: 'wx', mode: 0o600 })
      const tracked = scratchRootTrackingNodeAdapter()
      const acknowledgementLoss = new Error('injected payload rmdir acknowledgement loss')
      const state = {
        active: false,
        phase: 'idle' as 'idle' | 'block' | 'acknowledgement-loss',
        blockerCreated: false,
        acknowledgementLost: false,
        payloadRmdirAttempts: 0,
        linkUnlinks: 0,
        realRmdirFailure: undefined as unknown,
        scratchPath: undefined as string | undefined,
        quarantinePath: undefined as string | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async unlink(path) {
          if (state.active && state.quarantinePath !== undefined
            && path === join(state.quarantinePath, 'payload', 'external-link')) {
            state.linkUnlinks += 1
          }
          await tracked.unlink(path)
        },
        async rmdir(path) {
          if (!state.active || state.quarantinePath === undefined
            || path !== join(state.quarantinePath, 'payload')) {
            await tracked.rmdir(path)
            return
          }
          state.payloadRmdirAttempts += 1
          if (state.phase === 'block' && !state.blockerCreated) {
            state.blockerCreated = true
            await writeFile(join(path, 'blocker'), blocker, { flag: 'wx', mode: 0o600 })
            try {
              await tracked.rmdir(path)
            } catch (error) {
              state.realRmdirFailure = error
              throw error
            }
            throw new Error('real non-empty payload rmdir unexpectedly succeeded')
          }
          await tracked.rmdir(path)
          if (state.phase === 'acknowledgement-loss' && !state.acknowledgementLost) {
            state.acknowledgementLost = true
            throw acknowledgementLoss
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '7', 69)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const payloadPath = join(scratch.path, 'payload')
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const quarantinePayloadPath = join(quarantinePath, 'payload')
      const witnessPath = `${quarantinePath}.owner`
      for (const cleanupPath of [quarantinePath, witnessPath]) {
        if (!roots.includes(cleanupPath)) roots.push(cleanupPath)
      }
      const linkPath = join(payloadPath, 'external-link')
      const quarantineLinkPath = join(quarantinePayloadPath, 'external-link')
      const blockerPath = join(payloadPath, 'blocker')
      const indexPath = join(root, '.git', 'index')
      const frozenWorld: FrozenGitMutationWorld = {
        ...await captureUnpublishedGitMutationWorld(root, indexPath, `${indexPath}.lock`),
        pinPath: durable.effectPlan.pin.path,
      }
      state.scratchPath = scratch.path
      state.quarantinePath = quarantinePath
      try {
        await symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
        state.phase = 'block'
        state.active = true

        const canceled = await execution.cancelOperation(
          prepared.preparation.operation,
          'source-canceled',
          signal,
        )

        expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
        expect(state).toMatchObject({
          blockerCreated: true,
          acknowledgementLost: false,
          payloadRmdirAttempts: 1,
          linkUnlinks: 1,
        })
        expect(state.realRmdirFailure).toMatchObject({ code: 'ENOTEMPTY' })
        const retainedScratch = await stat(scratch.path, { bigint: true })
        expect({ device: retainedScratch.dev.toString(), inode: retainedScratch.ino.toString() }).toEqual(
          scratch.identity,
        )
        const retainedPayload = await stat(payloadPath, { bigint: true })
        expect({ device: retainedPayload.dev.toString(), inode: retainedPayload.ino.toString() }).toEqual(
          scratch.payloadIdentity,
        )
        await expect(readFile(blockerPath)).resolves.toEqual(blocker)
        await expect(lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(targetSentinelPath)).resolves.toEqual(targetSentinel)
        await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expectFrozenGitMutationWorld(frozenWorld)

        await unlink(blockerPath)
        state.phase = 'acknowledgement-loss'
        expect(await execution.inspectOperation(
          prepared.preparation.operation,
          signal,
        )).toEqual(canceled)
        expect(state).toMatchObject({
          acknowledgementLost: true,
          payloadRmdirAttempts: 2,
          linkUnlinks: 1,
        })
        await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(targetSentinelPath)).resolves.toEqual(targetSentinel)
        await expectFrozenGitMutationWorld(frozenWorld)
      } finally {
        state.active = false
        await unlinkTestSymbolicLink(linkPath)
        await unlinkTestSymbolicLink(quarantineLinkPath)
      }
    }, 90_000)

    it('preserves an outer-rename collision, then stops when its quarantine disappears on replay', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-disappearing-quarantine-'))
      roots.push(holdingRoot)
      const firstForeignStash = join(holdingRoot, 'first-foreign')
      const secondForeignStash = join(holdingRoot, 'second-foreign')
      const ownedStash = join(holdingRoot, 'owned')
      const firstSentinel = Buffer.from('first foreign quarantine\n', 'utf8')
      const secondSentinel = Buffer.from('second foreign quarantine\n', 'utf8')
      const tracked = scratchRootTrackingNodeAdapter()
      const state = {
        active: false,
        phase: 'idle' as 'idle' | 'collision' | 'disappearing',
        outerInjected: false,
        outerRenameFailures: 0,
        originalChecksAfterOuterRename: 0,
        disappearances: 0,
        restoreRenames: 0,
        scratchPath: undefined as string | undefined,
        quarantinePath: undefined as string | undefined,
        witnessPath: undefined as string | undefined,
        firstForeignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
        secondForeignIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          if (state.active && state.outerInjected && path === state.scratchPath) {
            state.originalChecksAfterOuterRename += 1
            if (state.phase === 'disappearing' && state.originalChecksAfterOuterRename === 2
              && state.quarantinePath !== undefined) {
              await tracked.rename(state.quarantinePath, secondForeignStash)
              state.disappearances += 1
            }
          }
          return await tracked.lstat(path)
        },
        async rename(from, to) {
          if (!state.active || from !== state.scratchPath || to !== state.quarantinePath
            || state.scratchPath === undefined || state.quarantinePath === undefined) {
            if (state.active && from === state.quarantinePath && to === state.scratchPath) {
              state.restoreRenames += 1
            }
            await tracked.rename(from, to)
            return
          }
          state.outerInjected = true
          if (state.phase === 'collision') {
            await mkdir(state.quarantinePath, { mode: 0o700 })
            await writeFile(join(state.quarantinePath, 'sentinel'), firstSentinel, {
              flag: 'wx',
              mode: 0o600,
            })
            const foreign = await stat(state.quarantinePath, { bigint: true })
            state.firstForeignIdentity = {
              device: foreign.dev.toString(),
              inode: foreign.ino.toString(),
            }
          } else if (state.phase === 'disappearing') {
            await tracked.rename(state.scratchPath, ownedStash)
            await mkdir(state.quarantinePath, { mode: 0o700 })
            await writeFile(join(state.quarantinePath, 'sentinel'), secondSentinel, {
              flag: 'wx',
              mode: 0o600,
            })
            const foreign = await stat(state.quarantinePath, { bigint: true })
            state.secondForeignIdentity = {
              device: foreign.dev.toString(),
              inode: foreign.ino.toString(),
            }
          }
          try {
            await tracked.rename(from, to)
          } catch (error) {
            state.outerRenameFailures += 1
            throw error
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '4', 66)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      const ownerBytes = await readFile(join(scratch.path, 'owner'))
      const payloadIndex = await readFile(join(scratch.path, 'payload', 'target.index'))
      const indexPath = join(root, '.git', 'index')
      const frozenWorld: FrozenGitMutationWorld = {
        ...await captureUnpublishedGitMutationWorld(root, indexPath, `${indexPath}.lock`),
        pinPath: durable.effectPlan.pin.path,
      }
      state.scratchPath = scratch.path
      state.quarantinePath = quarantinePath
      state.witnessPath = witnessPath
      state.phase = 'collision'
      state.active = true

      const canceled = await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )
      expect(canceled).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
      expect(state).toMatchObject({
        outerInjected: true,
        outerRenameFailures: 1,
        originalChecksAfterOuterRename: 2,
        disappearances: 0,
        restoreRenames: 0,
      })
      const retainedScratch = await stat(scratch.path, { bigint: true })
      expect({ device: retainedScratch.dev.toString(), inode: retainedScratch.ino.toString() }).toEqual(
        scratch.identity,
      )
      const firstForeign = await stat(quarantinePath, { bigint: true })
      expect({ device: firstForeign.dev.toString(), inode: firstForeign.ino.toString() }).toEqual(
        state.firstForeignIdentity,
      )
      await expect(readFile(join(quarantinePath, 'sentinel'))).resolves.toEqual(firstSentinel)
      await expectFrozenGitMutationWorld(frozenWorld)

      await rename(quarantinePath, firstForeignStash)
      state.phase = 'disappearing'
      state.outerInjected = false
      state.outerRenameFailures = 0
      state.originalChecksAfterOuterRename = 0
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toEqual(canceled)

      expect(state).toMatchObject({
        outerInjected: true,
        outerRenameFailures: 1,
        originalChecksAfterOuterRename: 2,
        disappearances: 1,
        restoreRenames: 0,
      })
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const retainedOwned = await stat(ownedStash, { bigint: true })
      expect({ device: retainedOwned.dev.toString(), inode: retainedOwned.ino.toString() }).toEqual(
        scratch.identity,
      )
      await expect(readFile(join(ownedStash, 'owner'))).resolves.toEqual(ownerBytes)
      await expect(readFile(join(ownedStash, 'payload', 'target.index'))).resolves.toEqual(payloadIndex)
      const retainedFirstForeign = await stat(firstForeignStash, { bigint: true })
      expect({
        device: retainedFirstForeign.dev.toString(),
        inode: retainedFirstForeign.ino.toString(),
      }).toEqual(state.firstForeignIdentity)
      await expect(readFile(join(firstForeignStash, 'sentinel'))).resolves.toEqual(firstSentinel)
      const retainedSecondForeign = await stat(secondForeignStash, { bigint: true })
      expect({
        device: retainedSecondForeign.dev.toString(),
        inode: retainedSecondForeign.ino.toString(),
      }).toEqual(state.secondForeignIdentity)
      await expect(readFile(join(secondForeignStash, 'sentinel'))).resolves.toEqual(secondSentinel)
      await expectFrozenGitMutationWorld(frozenWorld)

      state.active = false
      await rename(ownedStash, quarantinePath)
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toEqual(canceled)
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(firstForeignStash, 'sentinel'))).resolves.toEqual(firstSentinel)
      await expect(readFile(join(secondForeignStash, 'sentinel'))).resolves.toEqual(secondSentinel)
      await expectFrozenGitMutationWorld(frozenWorld)
    }, 90_000)

    it('retries scratch allocation across payload type, confirmation, cleanup, and runtime races', async () => {
      type Phase = 'payload-type' | 'payload-confirmation' | 'runtime-ownership'

      const root = await repository()
      const tracked = scratchRootTrackingNodeAdapter()
      const runtimeFailure = Object.assign(new Error('injected scratch runtime ownership failure'), { code: 'EIO' })
      const cleanupFailure = Object.assign(new Error('injected payload rollback failure'), { code: 'EIO' })
      const state = {
        active: false,
        phase: undefined as Phase | undefined,
        scratchPath: undefined as string | undefined,
        payloadPath: undefined as string | undefined,
        payloadStats: 0,
        payloadConfirmed: false,
        injected: false,
        cleanupFailures: 0,
      }
      const reset = (phase: Phase): void => {
        Object.assign(state, {
          phase,
          scratchPath: undefined,
          payloadPath: undefined,
          payloadStats: 0,
          payloadConfirmed: false,
          injected: false,
          cleanupFailures: 0,
        })
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          const actual = await tracked.lstat(path)
          if (!state.active || state.phase === undefined) return actual
          if (basename(path).startsWith('saki-host-operation-') && dirname(path) === tmpdir()) {
            state.scratchPath ??= path
            if (state.phase === 'runtime-ownership' && state.payloadConfirmed && !state.injected) {
              state.injected = true
              throw runtimeFailure
            }
            return actual
          }
          if (state.scratchPath === undefined || path !== join(state.scratchPath, 'payload')) return actual
          state.payloadPath = path
          state.payloadStats += 1
          if (state.phase === 'payload-type' && state.payloadStats === 1) {
            Object.defineProperty(actual, 'isDirectory', {
              value: () => false,
              configurable: true,
            })
            state.injected = true
          } else if (state.payloadStats === 2) {
            state.payloadConfirmed = true
            if (state.phase === 'payload-confirmation') {
              Object.defineProperty(actual, 'dev', {
                value: actual.dev + 1n,
                enumerable: true,
                configurable: true,
              })
              state.injected = true
            }
          }
          return actual
        },
        async rmdir(path) {
          if (state.phase === 'payload-confirmation' && state.injected
            && path === state.payloadPath && state.cleanupFailures === 0) {
            state.cleanupFailures += 1
            throw cleanupFailure
          }
          await tracked.rmdir(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, 'f', 100)
      const indexPath = join(root, '.git', 'index')
      const originalIndex = await readFile(indexPath)
      state.active = true

      for (const phase of ['payload-type', 'payload-confirmation'] as const) {
        reset(phase)
        expect(await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).toMatchObject({
          ok: false,
          reason: 'unavailable',
          snapshot: { state: 'planning' },
        })
        expect(state.injected).toBe(true)
        if (phase === 'payload-confirmation') expect(state.cleanupFailures).toBe(1)
        await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
      }

      reset('runtime-ownership')
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'planning' },
      })
      expect(state.injected).toBe(true)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)

      state.phase = undefined
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    }, 180_000)

    it('replays owned payload cleanup across disappearing, drifting, and acknowledged-lost entries', async () => {
      type Phase =
        | 'initial-unavailable'
        | 'initial-and-confirmation'
        | 'confirmation-drift'
        | 'unlink-retained'
        | 'unlink-acknowledged'

      const root = await repository()
      const tracked = scratchRootTrackingNodeAdapter()
      const entryFailure = Object.assign(new Error('injected payload entry metadata failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'lstat',
      })
      const unlinkFailure = Object.assign(new Error('injected payload entry unlink failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'unlink',
      })
      const state = {
        active: false,
        phase: undefined as Phase | undefined,
        quarantinePayloadPath: undefined as string | undefined,
        targetIndexPath: undefined as string | undefined,
        alternatesPath: undefined as string | undefined,
        looseObjectPath: undefined as string | undefined,
        lstatCalls: new Map<string, number>(),
        initialMissing: false,
        confirmationMissing: false,
        injected: false,
      }
      const reset = (phase: Phase): void => {
        state.phase = phase
        state.lstatCalls.clear()
        state.injected = false
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          if (!state.active || state.phase === undefined) return await tracked.lstat(path)
          const calls = (state.lstatCalls.get(path) ?? 0) + 1
          state.lstatCalls.set(path, calls)
          if (state.phase === 'initial-and-confirmation' && path === state.targetIndexPath && calls === 1) {
            await tracked.unlink(path)
            state.initialMissing = true
            return await tracked.lstat(path)
          }
          if (state.phase === 'initial-and-confirmation' && path === state.alternatesPath && calls === 2) {
            await tracked.unlink(path)
            state.confirmationMissing = true
            return await tracked.lstat(path)
          }
          if (state.phase === 'initial-unavailable' && path === state.looseObjectPath && calls === 1) {
            state.injected = true
            throw Object.assign(entryFailure, { path })
          }
          const actual = await tracked.lstat(path)
          if (path !== state.looseObjectPath || calls !== 2) return actual
          if (state.phase === 'initial-and-confirmation') {
            state.injected = true
            throw Object.assign(entryFailure, { path })
          }
          if (state.phase === 'confirmation-drift') {
            Object.defineProperty(actual, 'dev', {
              value: actual.dev + 1n,
              enumerable: true,
              configurable: true,
            })
            state.injected = true
          }
          return actual
        },
        async readdir(path) {
          const entries = [...await tracked.readdir(path)]
          if (!state.active || state.phase !== 'initial-and-confirmation') return entries
          if (path === state.quarantinePayloadPath) {
            return ['target.index', 'hooks', 'objects'].filter(entry => entries.includes(entry))
          }
          if (path === join(state.quarantinePayloadPath ?? '', 'objects')) {
            return ['info', ...entries.filter(entry => entry !== 'info')]
          }
          return entries
        },
        async unlink(path) {
          if (state.active && path === state.looseObjectPath) {
            if (state.phase === 'unlink-retained') {
              state.injected = true
              throw Object.assign(unlinkFailure, { path })
            }
            if (state.phase === 'unlink-acknowledged') {
              await tracked.unlink(path)
              state.injected = true
              throw Object.assign(unlinkFailure, { path })
            }
          }
          await tracked.unlink(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'd', 102)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const privateObjects = join(scratch.path, 'payload', 'objects')
      const fanout = (await readdir(privateObjects)).find(entry => /^[0-9a-f]{2}$/u.test(entry))
      if (fanout === undefined) throw new Error('test retained no private loose-object fanout')
      const suffix = (await readdir(join(privateObjects, fanout)))[0]
      if (suffix === undefined) throw new Error('test retained no private loose object')
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      state.quarantinePayloadPath = join(quarantinePath, 'payload')
      state.targetIndexPath = join(state.quarantinePayloadPath, 'target.index')
      state.alternatesPath = join(state.quarantinePayloadPath, 'objects', 'info', 'alternates')
      state.looseObjectPath = join(state.quarantinePayloadPath, 'objects', fanout, suffix)
      state.active = true

      reset('initial-unavailable')
      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'canceled', reason: 'source-canceled', effect: 'none' })
      expect(state.injected).toBe(true)
      await expect(stat(scratch.path)).resolves.toBeDefined()

      reset('initial-and-confirmation')
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'canceled', reason: 'source-canceled', effect: 'none' })
      expect(state).toMatchObject({ initialMissing: true, confirmationMissing: true, injected: true })
      await expect(stat(scratch.path)).resolves.toBeDefined()

      reset('confirmation-drift')
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'canceled', reason: 'source-canceled', effect: 'none' })
      expect(state.injected).toBe(true)
      await expect(stat(scratch.path)).resolves.toBeDefined()

      reset('unlink-retained')
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'canceled', reason: 'source-canceled', effect: 'none' })
      expect(state.injected).toBe(true)
      await expect(stat(scratch.path)).resolves.toBeDefined()

      reset('unlink-acknowledged')
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'canceled', reason: 'source-canceled', effect: 'none' })
      expect(state.injected).toBe(true)
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 180_000)

    it('acknowledges payload removal after an initial entry metadata failure', async () => {
      const root = await repository()
      const tracked = scratchRootTrackingNodeAdapter()
      const entryFailure = Object.assign(new Error('injected initial payload entry metadata failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'lstat',
      })
      const state = {
        active: false,
        injected: false,
        payloadPath: undefined as string | undefined,
        entryPath: undefined as string | undefined,
        entryLstats: 0,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          if (!state.active || state.injected || path !== state.entryPath
            || state.payloadPath === undefined) return await tracked.lstat(path)
          state.entryLstats += 1
          await rm(state.payloadPath, { recursive: true, force: false })
          state.injected = true
          throw Object.assign(entryFailure, { path })
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'e', 106)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      const witnessPath = `${quarantinePath}.owner`
      state.payloadPath = join(quarantinePath, 'payload')
      state.entryPath = join(state.payloadPath, 'target.index')
      for (const cleanupPath of [quarantinePath, witnessPath]) {
        if (!roots.includes(cleanupPath)) roots.push(cleanupPath)
      }
      const indexPath = join(root, '.git', 'index')
      const frozenWorld: FrozenGitMutationWorld = {
        ...await captureUnpublishedGitMutationWorld(root, indexPath, `${indexPath}.lock`),
        pinPath: durable.effectPlan.pin.path,
      }
      state.active = true

      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'canceled', reason: 'source-canceled', effect: 'none' })
      expect(state).toMatchObject({ injected: true, entryLstats: 1 })
      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expectFrozenGitMutationWorld(frozenWorld)
    }, 90_000)

    it.each([
      {
        name: 'inner ownership disappears',
        finalPhase: 'inner-missing',
        prefixPhases: ['inner-unavailable', 'loop-identity', 'before-removal-foreign'],
        payloadDigit: '1',
        admissionRevision: 103,
      },
      {
        name: 'enumeration acknowledges a disappeared payload',
        finalPhase: 'readdir-missing',
        prefixPhases: [],
        payloadDigit: '2',
        admissionRevision: 104,
      },
      {
        name: 'final ownership check observes removal',
        finalPhase: 'before-removal-missing',
        prefixPhases: [],
        payloadDigit: '3',
        admissionRevision: 105,
      },
    ] as const)('cleans an owned payload when $name', async ({
      finalPhase,
      prefixPhases,
      payloadDigit,
      admissionRevision,
    }) => {
      type Phase =
        | 'inner-missing'
        | 'inner-unavailable'
        | 'loop-identity'
        | 'before-removal-foreign'
        | 'readdir-missing'
        | 'before-removal-missing'

      const root = await repository()
      const tracked = scratchRootTrackingNodeAdapter()
      const state = {
        active: false,
        phase: undefined as Phase | undefined,
        quarantinePayloadPath: undefined as string | undefined,
        payloadLstats: 0,
        enumerated: false,
        injected: false,
      }
      const reset = (phase: Phase): void => {
        Object.assign(state, {
          phase,
          payloadLstats: 0,
          enumerated: false,
          injected: false,
        })
      }
      const unavailable = (path: string): NodeJS.ErrnoException => Object.assign(
        new Error('injected owned payload metadata failure'),
        { code: 'EIO', errno: -5, syscall: 'lstat', path },
      )
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          if (!state.active || state.phase === undefined || path !== state.quarantinePayloadPath) {
            return await tracked.lstat(path)
          }
          state.payloadLstats += 1
          if (state.payloadLstats === 2 && state.phase === 'inner-missing') {
            await rm(path, { recursive: true, force: false })
            state.injected = true
            return await tracked.lstat(path)
          }
          if (state.payloadLstats === 2 && state.phase === 'inner-unavailable') {
            state.injected = true
            throw unavailable(path)
          }
          if (state.payloadLstats === 4 && state.phase === 'loop-identity') {
            const actual = await tracked.lstat(path)
            Object.defineProperty(actual, 'dev', {
              value: actual.dev + 1n,
              enumerable: true,
              configurable: true,
            })
            state.injected = true
            return actual
          }
          if (state.payloadLstats === 4 && state.phase === 'before-removal-foreign') {
            const actual = await tracked.lstat(path)
            Object.defineProperty(actual, 'dev', {
              value: actual.dev + 1n,
              enumerable: true,
              configurable: true,
            })
            state.injected = true
            return actual
          }
          if (state.payloadLstats === 4 && state.phase === 'before-removal-missing') {
            await rm(path, { recursive: true, force: false })
            state.injected = true
            return await tracked.lstat(path)
          }
          return await tracked.lstat(path)
        },
        async readdir(path) {
          if (!state.active || state.phase === undefined || path !== state.quarantinePayloadPath) {
            return await tracked.readdir(path)
          }
          if (state.phase === 'readdir-missing') {
            await rm(path, { recursive: true, force: false })
            state.injected = true
            throw unavailable(path)
          }
          if (state.phase === 'before-removal-foreign' || state.phase === 'before-removal-missing') {
            state.enumerated = true
            return []
          }
          return await tracked.readdir(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        payloadDigit,
        admissionRevision,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const scratch = durable.effectPlan.scratch
      const quarantinePath = `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
      state.quarantinePayloadPath = join(quarantinePath, 'payload')
      state.active = true

      let canceled = false
      for (const phase of [...prefixPhases, finalPhase] as readonly Phase[]) {
        reset(phase)
        const snapshot = canceled
          ? await execution.inspectOperation(prepared.preparation.operation, signal)
          : await execution.cancelOperation(
            prepared.preparation.operation,
            'source-canceled',
            signal,
          )
        canceled = true
        expect(snapshot).toMatchObject({ state: 'canceled', reason: 'source-canceled', effect: 'none' })
        expect(state.injected).toBe(true)
        if (phase === 'before-removal-foreign' || phase === 'before-removal-missing') {
          expect(state.enumerated).toBe(true)
        }
        if (phase !== finalPhase) await expect(stat(scratch.path)).resolves.toBeDefined()
      }

      await expect(stat(scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 180_000)
  })

  describe('Git publication Node failure boundaries', () => {
    it('does not persist a plan before the scratch hierarchy reaches its parent directory', async () => {
      const root = await repository()
      const tracked = scratchRootTrackingNodeAdapter()
      const barrierFailure = new Error('injected scratch parent durability failure')
      const state = { active: false, parentSyncs: 0, publishingRecords: 0, syncs: [] as string[] }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async syncDirectory(path) {
          if (state.active) state.syncs.push(path)
          if (state.active && path === tmpdir()) {
            state.parentSyncs += 1
            throw barrierFailure
          }
          await tracked.syncDirectory(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '9', 85)
      const persistence = operationPersistence(execution)
      persistence.replace(async (record) => {
        if (record.snapshot.state === 'publishing') state.publishingRecords += 1
        await persistence.original(record)
      })
      state.active = true

      try {
        await expect(execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).rejects.toBe(barrierFailure)
      } finally {
        persistence.restore()
      }

      expect(state).toMatchObject({ active: true, parentSyncs: 1, publishingRecords: 0 })
      const infoIndex = state.syncs.findLastIndex(path => basename(path) === 'info')
      const parentIndex = state.syncs.findIndex((path, index) => index > infoIndex && path === tmpdir())
      const barrierSyncs = state.syncs.slice(infoIndex, parentIndex + 1)
      const objectsIndex = barrierSyncs.findIndex(path => basename(path) === 'objects')
      const infoPath = state.syncs[infoIndex]
      const fanoutPaths = barrierSyncs.slice(1, objectsIndex)
      const [objectsPath, payloadPath, scratchPath, parentPath] = barrierSyncs.slice(objectsIndex)
      expect(basename(infoPath ?? '')).toBe('info')
      expect(dirname(infoPath ?? '')).toBe(objectsPath)
      expect(fanoutPaths.length).toBeGreaterThan(0)
      expect(fanoutPaths.every(path => dirname(path) === objectsPath
        && /^[0-9a-f]{2}$/u.test(basename(path)))).toBe(true)
      expect(basename(objectsPath ?? '')).toBe('objects')
      expect(dirname(objectsPath ?? '')).toBe(payloadPath)
      expect(basename(payloadPath ?? '')).toBe('payload')
      expect(dirname(payloadPath ?? '')).toBe(scratchPath)
      expect(dirname(scratchPath ?? '')).toBe(parentPath)
      expect(parentPath).toBe(tmpdir())
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'planning' })
      const gitEntries = await readdir(join(root, '.git'))
      expect(gitEntries).not.toContain('index.lock')
      expect(gitEntries.some(name => name.endsWith('.pin'))).toBe(false)
    }, 90_000)

    it('stops the private object barrier after cancellation between fanout syncs', async () => {
      const root = await repository()
      const sourceObjects = join(root, '.git', 'objects')
      const tracked = scratchRootTrackingNodeAdapter()
      const controller = new AbortController()
      const abortReason = new Error('cancel private object barrier')
      const state = {
        active: false,
        abortedFanout: undefined as string | undefined,
        postAbortObjectSyncs: [] as string[],
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async syncDirectory(path) {
          if (state.active && state.abortedFanout === undefined
            && dirname(path) !== sourceObjects
            && /^[0-9a-f]{2}$/u.test(basename(path))
            && basename(dirname(path)) === 'objects') {
            await tracked.syncDirectory(path)
            state.abortedFanout = path
            controller.abort(abortReason)
            return
          }
          if (state.abortedFanout !== undefined) {
            const privateObjects = dirname(state.abortedFanout)
            if (path === privateObjects || dirname(path) === privateObjects) {
              state.postAbortObjectSyncs.push(path)
            }
          }
          await tracked.syncDirectory(path)
        },
      }
      const execution = await provider(root, { node })
      const setupSignal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, setupSignal, '8', 94)
      state.active = true

      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        controller.signal,
      )).rejects.toBe(abortReason)

      expect(state.abortedFanout).toBeDefined()
      expect(state.postAbortObjectSyncs).toEqual([])
    }, 90_000)

    it('stops a private object manifest scan after cancellation between object stats', async () => {
      const root = await repository()
      const sourceObjects = join(root, '.git', 'objects')
      const tracked = scratchRootTrackingNodeAdapter()
      const controller = new AbortController()
      const abortReason = new Error('cancel private object manifest')
      const state = {
        active: false,
        objectDirectory: undefined as string | undefined,
        objectStats: [] as string[],
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          const observed = await tracked.lstat(path)
          const fanout = dirname(path)
          const objectDirectory = dirname(fanout)
          if (state.active && objectDirectory !== sourceObjects
            && basename(objectDirectory) === 'objects'
            && /^[0-9a-f]{2}$/u.test(basename(fanout))
            && /^(?:[0-9a-f]{38}|[0-9a-f]{62})$/u.test(basename(path))) {
            state.objectDirectory ??= objectDirectory
            if (objectDirectory === state.objectDirectory) {
              state.objectStats.push(path)
              if (state.objectStats.length === 1) controller.abort(abortReason)
            }
          }
          return observed
        },
      }
      const execution = await provider(root, { node })
      const setupSignal = new AbortController().signal
      const { prepared } = await preparedCommit(
        execution,
        root,
        setupSignal,
        '2',
        95,
        'cancel private manifest\n',
        'Cancel private manifest',
      )
      state.active = true

      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        controller.signal,
      )).rejects.toBe(abortReason)

      expect(state.objectStats).toHaveLength(1)
    }, 90_000)

    it('releases a Commit index pin when the scratch hierarchy barrier fails', async () => {
      const root = await repository()
      const tracked = scratchRootTrackingNodeAdapter()
      const barrierFailure = new Error('injected Commit scratch parent durability failure')
      const state = { active: false, parentSyncs: 0, publishingRecords: 0 }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async syncDirectory(path) {
          if (state.active && path === tmpdir()) {
            state.parentSyncs += 1
            throw barrierFailure
          }
          await tracked.syncDirectory(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedCommit(
        execution,
        root,
        signal,
        'a',
        86,
        'Commit barrier failure\n',
        'Commit barrier failure',
      )
      const persistence = operationPersistence(execution)
      persistence.replace(async (record) => {
        if (record.snapshot.state === 'publishing') state.publishingRecords += 1
        await persistence.original(record)
      })
      state.active = true

      try {
        await expect(execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).rejects.toBe(barrierFailure)
      } finally {
        persistence.restore()
      }

      expect(state).toEqual({ active: true, parentSyncs: 1, publishingRecords: 0 })
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'planning' })
      const gitEntries = await readdir(join(root, '.git'))
      expect(gitEntries).not.toContain('index.lock')
      expect(gitEntries.some(name => name.endsWith('.pin'))).toBe(false)
    }, 90_000)

    it.each([
      ['initial', false],
      ['durable resume', true],
    ] as const)('does not persist a Stage %s attempt before its exact source object namespace is synced', async (
      _flow,
      resume,
    ) => {
      const root = await repository()
      const tracked = scratchRootTrackingNodeAdapter()
      const barrierFailure = new Error('injected Stage source object durability failure')
      const state = { active: false, attemptingRecords: 0, sourceSyncs: [] as string[] }
      let sourceObjects = ''
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async syncDirectory(path) {
          if (state.active && (path === sourceObjects || dirname(path) === sourceObjects)) {
            state.sourceSyncs.push(path)
            if (path === sourceObjects) throw barrierFailure
          }
          await tracked.syncDirectory(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const retained = resume
        ? await captureDurableNotStartedStage(execution, root, signal, '7', 88)
        : await preparedStage(execution, root, signal, '7', 88)
      const { prepared } = retained
      const binding = 'binding' in retained
        ? retained.binding
        : retained.durable.request.expected.binding
      sourceObjects = join(binding.expectedInspection.trusted.canonicalCommonGitDirectory, 'objects')
      const objectId = await gitText(root, 'hash-object', '--no-filters', '--', 'tracked.txt')
      const expectedFanout = join(sourceObjects, objectId.slice(0, 2))
      const persistence = operationPersistence(execution)
      persistence.replace(async (record) => {
        if (record.effectPlan?.publication === 'attempting') state.attemptingRecords += 1
        await persistence.original(record)
      })
      state.active = true

      try {
        await expect(execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).rejects.toBe(barrierFailure)
      } finally {
        persistence.restore()
      }

      expect(state).toEqual({
        active: true,
        attemptingRecords: 0,
        sourceSyncs: [expectedFanout, sourceObjects],
      })
      await expect(stat(join(expectedFanout, objectId.slice(2)))).resolves.toMatchObject({})
    }, 90_000)

    it('accepts an exact Stage object that already exists only in a pack without per-OID Git probes', async () => {
      const root = await repository()
      const base = await gitText(root, 'rev-parse', 'HEAD')
      await writeFile(join(root, 'tracked.txt'), 'changed\n')
      await git(root, 'add', '--', 'tracked.txt')
      await git(root, 'commit', '-m', 'retain packed candidate')
      await git(root, 'branch', 'packed-candidate')
      const objectId = await gitText(root, 'rev-parse', 'packed-candidate:tracked.txt')
      await git(root, 'reset', '--hard', base)
      await git(root, 'gc', '--prune=now')
      const sourceObjects = join(root, '.git', 'objects')
      await expect(stat(join(sourceObjects, objectId.slice(0, 2), objectId.slice(2))))
        .rejects.toMatchObject({ code: 'ENOENT' })
      const tracked = scratchRootTrackingNodeAdapter()
      const state = { catFileQueries: 0, sourceSyncs: [] as string[] }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async syncDirectory(path) {
          if (path === sourceObjects || dirname(path) === sourceObjects) state.sourceSyncs.push(path)
          await tracked.syncDirectory(path)
        },
      }
      const execution = await provider(root, { node })
      const runner = mutationRunner(execution)
      runner.replaceRun(async (...args) => {
        if (args[1][0] === 'cat-file') state.catFileQueries += 1
        return await runner.originalRun(...args)
      })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '5', 91)

      try {
        expect(await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      } finally {
        runner.restore()
      }

      expect(state).toEqual({ catFileQueries: 0, sourceSyncs: [] })
    }, 120_000)

    it('retries Stage when a classified loose object disappears after its fanout barrier', async () => {
      const root = await repository()
      const tracked = scratchRootTrackingNodeAdapter()
      const state = { active: false, removed: false, writeTreesAfterRemoval: 0 }
      let objectPath = ''
      let sourceFanout = ''
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async syncDirectory(path) {
          await tracked.syncDirectory(path)
          if (state.active && !state.removed && path === sourceFanout) {
            await unlink(objectPath)
            state.removed = true
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, binding } = await preparedStage(execution, root, signal, '4', 96)
      const sourceObjects = join(
        binding.expectedInspection.trusted.canonicalCommonGitDirectory,
        'objects',
      )
      const objectId = await gitText(root, 'hash-object', '--no-filters', '--', 'tracked.txt')
      sourceFanout = join(sourceObjects, objectId.slice(0, 2))
      objectPath = join(sourceFanout, objectId.slice(2))
      const runner = mutationRunner(execution)
      runner.replace(async (...args) => {
        if (state.removed && args[1][0] === 'write-tree') state.writeTreesAfterRemoval += 1
        return await runner.original(...args)
      })
      state.active = true

      let started
      try {
        started = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } finally {
        runner.restore()
      }

      expect(started).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing' },
      })
      expect(state).toEqual({ active: true, removed: true, writeTreesAfterRemoval: 0 })
      await expect(stat(objectPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('classifies exact source object topology and fanout failures before publication', async () => {
      type Phase =
        | 'root-type'
        | 'object-eio'
        | 'topology'
        | 'sync-enoent'
        | 'sync-eio'
        | 'final-type'
        | 'final-eio'
        | 'sync-abort'

      const root = await repository()
      const sourceObjects = join(root, '.git', 'objects')
      const tracked = scratchRootTrackingNodeAdapter()
      const controller = new AbortController()
      const abortReason = new Error('caller stopped during exact source fanout sync')
      const state = {
        phase: undefined as Phase | undefined,
        injected: false,
        objectStats: new Map<string, number>(),
      }
      const reset = (phase: Phase): void => {
        state.phase = phase
        state.injected = false
        state.objectStats.clear()
      }
      const nodeFailure = (code: 'EIO' | 'ENOENT', syscall: 'lstat' | 'fsync', path: string): Error & {
        readonly code: 'EIO' | 'ENOENT'
      } => Object.assign(new Error(`injected exact source ${syscall} ${code}`), {
        code,
        errno: code === 'ENOENT' ? -4058 : -5,
        syscall,
        path,
      })
      const isFanout = (path: string): boolean => dirname(path) === sourceObjects
        && /^[0-9a-f]{2}$/u.test(basename(path))
      const isLooseObject = (path: string): boolean => dirname(dirname(path)) === sourceObjects
        && /^[0-9a-f]{2}$/u.test(basename(dirname(path)))
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          const actual = await tracked.lstat(path)
          if (state.phase === undefined) return actual
          if (path === sourceObjects && state.phase === 'root-type' && !state.injected) {
            Object.defineProperty(actual, 'isDirectory', {
              value: () => false,
              configurable: true,
            })
            state.injected = true
            return actual
          }
          if (isLooseObject(path)) {
            const calls = (state.objectStats.get(path) ?? 0) + 1
            state.objectStats.set(path, calls)
            if (calls === 1 && state.phase === 'object-eio' && !state.injected) {
              state.injected = true
              throw nodeFailure('EIO', 'lstat', path)
            }
            if (calls === 2 && state.phase === 'final-type' && !state.injected) {
              Object.defineProperty(actual, 'isFile', {
                value: () => false,
                configurable: true,
              })
              state.injected = true
            } else if (calls === 2 && state.phase === 'final-eio' && !state.injected) {
              state.injected = true
              throw nodeFailure('EIO', 'lstat', path)
            }
            return actual
          }
          if (isFanout(path) && state.phase === 'topology' && !state.injected) {
            Object.defineProperty(actual, 'dev', {
              value: actual.dev + 1n,
              enumerable: true,
              configurable: true,
            })
            state.injected = true
          }
          return actual
        },
        async syncDirectory(path) {
          if (isFanout(path) && state.phase !== undefined && !state.injected) {
            if (state.phase === 'sync-enoent') {
              state.injected = true
              throw nodeFailure('ENOENT', 'fsync', path)
            }
            if (state.phase === 'sync-eio') {
              state.injected = true
              throw nodeFailure('EIO', 'fsync', path)
            }
            if (state.phase === 'sync-abort') {
              state.injected = true
              controller.abort(abortReason)
              throw nodeFailure('EIO', 'fsync', path)
            }
          }
          await tracked.syncDirectory(path)
        },
      }
      const execution = await provider(root, { node })
      const { prepared } = await captureDurableNotStartedStage(
        execution,
        root,
        controller.signal,
        'e',
        101,
      )
      const indexPath = join(root, '.git', 'index')
      const originalIndex = await readFile(indexPath)

      for (const phase of ['root-type', 'topology', 'sync-enoent', 'final-type'] as const) {
        reset(phase)
        expect(await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          controller.signal,
        )).toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
        expect(state.injected).toBe(true)
      }
      for (const phase of ['object-eio', 'sync-eio', 'final-eio'] as const) {
        reset(phase)
        await expect(execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          controller.signal,
        )).rejects.toMatchObject({ code: 'EIO' })
        expect(state.injected).toBe(true)
      }

      reset('sync-abort')
      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        controller.signal,
      )).rejects.toBe(abortReason)
      expect(state.injected).toBe(true)
      await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
    }, 180_000)

    it.each([
      ['loose', false],
      ['packed', true],
    ] as const)('commits a staged tree reused from %s source objects', async (_storage, packed) => {
      const root = await repository()
      await mkdir(join(root, 'nested'))
      await writeFile(join(root, 'nested', 'reused.txt'), 'reused nested tree\n')
      await writeFile(join(root, 'tracked.txt'), 'reused candidate tree\n')
      await git(root, 'add', '--', 'tracked.txt', 'nested/reused.txt')
      await git(root, 'commit', '-m', 'retain candidate tree')
      const reusedTree = await gitText(root, 'rev-parse', 'HEAD^{tree}')
      const reusedNestedTree = await gitText(root, 'rev-parse', 'HEAD:nested')
      await writeFile(join(root, 'tracked.txt'), 'different current parent tree\n')
      await git(root, 'add', '--', 'tracked.txt')
      await git(root, 'commit', '-m', 'current parent tree')
      expect(await gitText(root, 'rev-parse', 'HEAD^{tree}')).not.toBe(reusedTree)
      if (packed) await git(root, 'gc', '--prune=now')
      const sourceTreePaths = [reusedTree, reusedNestedTree].map(treeId => join(
        root,
        '.git',
        'objects',
        treeId.slice(0, 2),
        treeId.slice(2),
      ))
      for (const treePath of sourceTreePaths) {
        const expectation = expect(stat(treePath))
        if (packed) await expectation.rejects.toMatchObject({ code: 'ENOENT' })
        else await expectation.resolves.toMatchObject({})
      }
      const reusedTreeFanout = dirname(sourceTreePaths[0] ?? '')
      const tracked = scratchRootTrackingNodeAdapter()
      const state = { active: false, catFileQueries: 0, reusedTreeFanoutSyncs: 0 }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async syncDirectory(path) {
          if (state.active && path === reusedTreeFanout) state.reusedTreeFanoutSyncs += 1
          await tracked.syncDirectory(path)
        },
      }
      const execution = await provider(root, { node })
      const runner = mutationRunner(execution)
      runner.replaceRun(async (...args) => {
        if (args[1][0] === 'cat-file') state.catFileQueries += 1
        return await runner.originalRun(...args)
      })
      const signal = new AbortController().signal
      const { prepared } = await preparedCommit(
        execution,
        root,
        signal,
        '1',
        97,
        'reused candidate tree\n',
        `Commit reused ${_storage} tree`,
      )
      state.active = true
      const persistence = operationPersistence(execution)
      let privateTreesAbsent: boolean | undefined
      persistence.replace(async (record) => {
        if (privateTreesAbsent === undefined && record.effectPlan?.kind === 'commit') {
          const privateObjectDirectory = join(record.effectPlan.scratch.path, 'payload', 'objects')
          const absences = await Promise.all([reusedTree, reusedNestedTree].map(async (treeId) => {
            try {
              await stat(join(
                privateObjectDirectory,
                treeId.slice(0, 2),
                treeId.slice(2),
              ))
              return false
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
              return true
            }
          }))
          privateTreesAbsent = absences.every(Boolean)
        }
        await persistence.original(record)
      })

      let started
      try {
        started = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } finally {
        persistence.restore()
        runner.restore()
      }

      expect(privateTreesAbsent).toBe(true)
      expect(started).toMatchObject({
        ok: true,
        snapshot: { state: 'succeeded', result: { type: 'commit', treeId: reusedTree } },
      })
      expect(state.catFileQueries).toBe(0)
      if (packed) expect(state.reusedTreeFanoutSyncs).toBe(0)
      else expect(state.reusedTreeFanoutSyncs).toBeGreaterThanOrEqual(1)
    }, 120_000)

    it.each([
      ['initial', false, false],
      ['durable resume', true, false],
      ['initial with unavailable cleanup', false, true],
    ] as const)('does not persist a Commit %s attempt before its commit and complete tree namespace are synced', async (
      _flow,
      resume,
      cleanupUnavailable,
    ) => {
      const root = await repository()
      await mkdir(join(root, 'nested', 'deeper'), { recursive: true })
      await writeFile(join(root, 'nested', 'deeper', 'candidate.txt'), 'nested candidate\n')
      await git(root, 'add', '--', 'nested/deeper/candidate.txt')
      const tracked = scratchRootTrackingNodeAdapter()
      const barrierFailure = new Error('injected Commit source object durability failure')
      const lockPath = join(root, '.git', 'index.lock')
      const cleanupFailure = Object.assign(new Error('injected Commit source barrier cleanup failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'lstat',
        path: lockPath,
      })
      const state = {
        active: false,
        attemptingRecords: 0,
        sourceSyncs: [] as string[],
        expectedSourceSyncs: [] as string[],
        barrierFailed: false,
        cleanupFailures: 0,
      }
      let sourceObjects = ''
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          if (cleanupUnavailable && state.barrierFailed && path === lockPath && state.cleanupFailures === 0) {
            state.cleanupFailures += 1
            throw cleanupFailure
          }
          return await tracked.lstat(path)
        },
        async syncDirectory(path) {
          if (state.active && (path === sourceObjects || dirname(path) === sourceObjects)) {
            state.sourceSyncs.push(path)
            if (path === sourceObjects) {
              state.barrierFailed = true
              throw barrierFailure
            }
          }
          await tracked.syncDirectory(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const retained = resume
        ? await captureDurableNotStartedCommit(
          execution,
          root,
          signal,
          '8',
          89,
          'commit source barrier\n',
          'Commit source barrier',
        )
        : await preparedCommit(
          execution,
          root,
          signal,
          '8',
          89,
          'commit source barrier\n',
          'Commit source barrier',
        )
      const { prepared } = retained
      const request = 'request' in retained ? retained.request : retained.durable.request
      sourceObjects = join(
        request.expected.binding.expectedInspection.trusted.canonicalCommonGitDirectory,
        'objects',
      )
      const captureExpectedSourceSyncs = async (record: LocalHostOperationRecord): Promise<void> => {
        if (record.effectPlan?.kind !== 'commit') return
        const privateObjects = join(record.effectPlan.scratch.path, 'payload', 'objects')
        const ids: string[] = []
        for (const fanout of await readdir(privateObjects)) {
          if (!/^[0-9a-f]{2}$/u.test(fanout)) continue
          for (const suffix of await readdir(join(privateObjects, fanout))) ids.push(`${fanout}${suffix}`)
        }
        expect(ids).toContain(record.effectPlan.result.commitId)
        expect(ids).toContain(record.effectPlan.result.treeId)
        expect(ids.length).toBeGreaterThanOrEqual(4)
        state.expectedSourceSyncs = [
          ...new Set(ids.map(objectId => join(sourceObjects, objectId.slice(0, 2)))),
        ].sort().concat(sourceObjects)
      }
      if ('durable' in retained) await captureExpectedSourceSyncs(retained.durable)
      const persistence = operationPersistence(execution)
      persistence.replace(async (record) => {
        await captureExpectedSourceSyncs(record)
        if (record.effectPlan?.publication === 'attempting') state.attemptingRecords += 1
        await persistence.original(record)
      })
      state.active = true

      let started: Awaited<ReturnType<typeof execution.startOperation>> | undefined
      let failure: unknown
      try {
        started = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } catch (error) {
        failure = error
      } finally {
        persistence.restore()
      }

      if (cleanupUnavailable) {
        expect(failure).toBeUndefined()
        expect(started).toMatchObject({
          ok: false,
          reason: 'unavailable',
          snapshot: { state: 'publishing' },
        })
        expect(state.cleanupFailures).toBe(1)
      } else if (failure !== undefined) {
        expect(failure).toBe(barrierFailure)
      } else {
        expect(started).toMatchObject({
          ok: false,
          reason: 'unavailable',
          snapshot: { state: 'publishing' },
        })
      }
      expect(state.barrierFailed).toBe(true)
      expect(state.attemptingRecords).toBe(0)
      expect(state.sourceSyncs).toEqual(state.expectedSourceSyncs)
    }, 120_000)

    it('does not record Commit success until reflog data and ref/reflog parent chains are synced', async () => {
      const root = await repository()
      const commonGitDirectory = join(root, '.git')
      const reflogPath = join(commonGitDirectory, 'logs', 'refs', 'heads', 'main')
      const expectedDirectories = [
        join(commonGitDirectory, 'refs', 'heads'),
        join(commonGitDirectory, 'refs'),
        join(commonGitDirectory, 'logs', 'refs', 'heads'),
        join(commonGitDirectory, 'logs', 'refs'),
        join(commonGitDirectory, 'logs'),
        commonGitDirectory,
      ]
      const tracked = scratchRootTrackingNodeAdapter()
      const barrierFailure = new Error('injected Commit reflog durability failure')
      const state = {
        active: false,
        failBarrier: true,
        reflogSyncFailures: 0,
        events: [] as string[],
        eventsAtSuccess: [] as string[],
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async open(path, flags, mode) {
          const handle = await tracked.open(path, flags, mode)
          if (path !== reflogPath || flags !== 'r+') return handle
          return {
            ...handle,
            async sync() {
              if (state.active) state.events.push(`file:${path}`)
              if (state.active && state.failBarrier) {
                state.reflogSyncFailures += 1
                throw barrierFailure
              }
              await handle.sync()
            },
          }
        },
        async syncDirectory(path) {
          if (state.active && expectedDirectories.includes(path)) state.events.push(`directory:${path}`)
          await tracked.syncDirectory(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedCommit(
        execution,
        root,
        signal,
        '6',
        90,
        'commit publication barrier\n',
        'Commit publication barrier',
      )
      const persistence = operationPersistence(execution)
      persistence.replace(async (record) => {
        if (record.snapshot.state === 'succeeded') state.eventsAtSuccess = [...state.events]
        await persistence.original(record)
      })
      state.active = true

      try {
        await expect(execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).rejects.toBe(barrierFailure)
        expect(state.reflogSyncFailures).toBe(2)

        await expect(execution.inspectOperation(
          prepared.preparation.operation,
          signal,
        )).rejects.toBe(barrierFailure)
        expect(state.reflogSyncFailures).toBe(3)

        state.failBarrier = false
        expect(await execution.inspectOperation(
          prepared.preparation.operation,
          signal,
        )).toMatchObject({ state: 'succeeded' })
      } finally {
        persistence.restore()
      }

      const finalFileBarrier = state.eventsAtSuccess.findLastIndex(event => event === `file:${reflogPath}`)
      expect(finalFileBarrier).toBeGreaterThanOrEqual(0)
      expect(state.eventsAtSuccess.slice(
        finalFileBarrier + 1,
        finalFileBarrier + 1 + expectedDirectories.length,
      )).toEqual(
        expectedDirectories.map(path => `directory:${path}`),
      )
    }, 120_000)

    it('retries the Commit barrier when the reflog changes after its file sync', async () => {
      const root = await repository()
      const commonGitDirectory = join(root, '.git')
      const reflogPath = join(commonGitDirectory, 'logs', 'refs', 'heads', 'main')
      const tracked = scratchRootTrackingNodeAdapter()
      const state = {
        active: false,
        raced: false,
        racingCommit: undefined as string | undefined,
        reflogSyncs: 0,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async open(path, flags, mode) {
          const handle = await tracked.open(path, flags, mode)
          if (path !== reflogPath || flags !== 'r+') return handle
          return {
            ...handle,
            async sync() {
              if (state.active) state.reflogSyncs += 1
              await handle.sync()
            },
          }
        },
        async syncDirectory(path) {
          await tracked.syncDirectory(path)
          if (!state.active || path !== commonGitDirectory || state.reflogSyncs !== 1 || state.raced) return
          state.raced = true
          const current = await gitText(root, 'rev-parse', 'refs/heads/main')
          const tree = await gitText(root, 'rev-parse', `${current}^{tree}`)
          state.racingCommit = await gitText(
            root,
            'commit-tree', tree, '-p', current, '-m', 'concurrent barrier advance',
          )
          await git(
            root,
            'update-ref', '-m', 'concurrent barrier advance',
            'refs/heads/main', state.racingCommit, current,
          )
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, publishedCommit } = await captureAcknowledgedLostAttachedCommit(
        execution,
        root,
        signal,
        '3',
        93,
      )
      state.active = true

      const raced = await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )

      expect(raced).toMatchObject({ state: 'publishing' })
      expect(state).toMatchObject({
        active: true,
        raced: true,
        reflogSyncs: 1,
      })
      expect(typeof state.racingCommit).toBe('string')
      expect(await gitText(root, 'rev-parse', 'refs/heads/main')).toBe(state.racingCommit)
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'succeeded', result: { type: 'commit', commitId: publishedCommit } })
      expect(state.reflogSyncs).toBe(2)
    }, 120_000)

    it('classifies Commit durability races at each frozen reflog and directory checkpoint', async () => {
      type Phase =
        | 'reflog-type'
        | 'open-identity'
        | 'post-sync-identity'
        | 'require-enoent'
        | 'require-eio'
        | 'directory-type'
        | 'directory-identity'
        | 'expected-identity'

      const root = await repository()
      const commonGitDirectory = join(root, '.git')
      const reflogPath = join(commonGitDirectory, 'logs', 'refs', 'heads', 'main')
      const tracked = scratchRootTrackingNodeAdapter()
      const closeFailure = Object.assign(new Error('injected reflog barrier close failure'), { code: 'EIO' })
      const state = {
        phase: undefined as Phase | undefined,
        markerRead: false,
        readWriteOpen: false,
        readWriteClosed: false,
        lstatCallsAfterClose: 0,
        commonDirectorySynced: false,
        injected: false,
        closeFailures: 0,
      }
      const reset = (phase: Phase): void => {
        Object.assign(state, {
          phase,
          markerRead: false,
          readWriteOpen: false,
          readWriteClosed: false,
          lstatCallsAfterClose: 0,
          commonDirectorySynced: false,
          injected: false,
          closeFailures: 0,
        })
      }
      const driftIdentity = <T extends { readonly dev: bigint }>(info: T): T => {
        Object.defineProperty(info, 'dev', {
          value: info.dev + 1n,
          enumerable: true,
          configurable: true,
        })
        return info
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async lstat(path) {
          const actual = await tracked.lstat(path)
          if (state.phase === undefined) return actual
          if (path === reflogPath) {
            if (state.markerRead && !state.readWriteOpen && !state.readWriteClosed
              && state.phase === 'reflog-type') {
              Object.defineProperty(actual, 'isFile', {
                value: () => false,
                configurable: true,
              })
              state.injected = true
              return actual
            }
            if (state.readWriteClosed) {
              state.lstatCallsAfterClose += 1
              if (state.lstatCallsAfterClose === 1 && state.phase === 'require-enoent') {
                state.injected = true
                throw Object.assign(new Error('injected missing reflog durability evidence'), {
                  code: 'ENOENT',
                  errno: -4058,
                  syscall: 'lstat',
                  path,
                })
              }
              if (state.lstatCallsAfterClose === 1 && state.phase === 'require-eio') {
                state.injected = true
                throw Object.assign(new Error('injected unavailable reflog durability evidence'), {
                  code: 'EIO',
                  errno: -5,
                  syscall: 'lstat',
                  path,
                })
              }
              if (state.lstatCallsAfterClose === 2 && state.phase === 'expected-identity') {
                state.injected = true
                return driftIdentity(actual)
              }
            }
          }
          if (path === commonGitDirectory && state.readWriteClosed) {
            if (state.phase === 'directory-type' && !state.commonDirectorySynced) {
              Object.defineProperty(actual, 'isDirectory', {
                value: () => false,
                configurable: true,
              })
              state.injected = true
            } else if (state.phase === 'directory-identity' && state.commonDirectorySynced) {
              state.injected = true
              return driftIdentity(actual)
            }
          }
          return actual
        },
        async open(path, flags, mode) {
          const handle = await tracked.open(path, flags, mode)
          if (state.phase === undefined || path !== reflogPath) return handle
          if (flags === 'r') {
            return {
              ...handle,
              async close() {
                await handle.close()
                state.markerRead = true
              },
            }
          }
          if (flags !== 'r+') return handle
          state.readWriteOpen = true
          let statCalls = 0
          return {
            ...handle,
            async stat() {
              const actual = await handle.stat()
              statCalls += 1
              if (statCalls === 1 && state.phase === 'open-identity') {
                state.injected = true
                return driftIdentity(actual)
              }
              if (statCalls === 2 && state.phase === 'post-sync-identity') {
                state.injected = true
                return driftIdentity(actual)
              }
              return actual
            },
            async close() {
              await handle.close()
              state.readWriteOpen = false
              state.readWriteClosed = true
              if (state.phase === 'open-identity') {
                state.closeFailures += 1
                throw closeFailure
              }
            },
          }
        },
        async syncDirectory(path) {
          await tracked.syncDirectory(path)
          if (state.phase === 'directory-identity' && state.readWriteClosed
            && path === commonGitDirectory) state.commonDirectorySynced = true
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, publishedCommit } = await captureAcknowledgedLostAttachedCommit(
        execution,
        root,
        signal,
        'f',
        99,
      )

      for (const phase of [
        'reflog-type',
        'open-identity',
        'post-sync-identity',
        'require-enoent',
        'directory-type',
        'directory-identity',
        'expected-identity',
      ] as const) {
        reset(phase)
        expect(await execution.inspectOperation(
          prepared.preparation.operation,
          signal,
        )).toMatchObject({ state: 'publishing' })
        expect(state.injected).toBe(true)
        if (phase === 'open-identity') expect(state.closeFailures).toBe(1)
      }

      reset('require-eio')
      await expect(execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).rejects.toMatchObject({ code: 'EIO' })
      expect(state.injected).toBe(true)

      state.phase = undefined
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({
        state: 'succeeded',
        result: { type: 'commit', commitId: publishedCommit },
      })
    }, 180_000)

    it('syncs and succeeds when the current Commit target proves publication beyond the reflog read bound', async () => {
      const root = await repository()
      const reflogPath = join(root, '.git', 'logs', 'refs', 'heads', 'main')
      expect((await stat(reflogPath)).size).toBeGreaterThan(1)
      const execution = await provider(root, { config: { operationMaxReflogBytes: 1 } })
      const signal = new AbortController().signal
      const { prepared } = await preparedCommit(
        execution,
        root,
        signal,
        '4',
        92,
        'large reflog durability\n',
        'Large reflog durability',
      )

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect((await stat(reflogPath)).size).toBeGreaterThan(1)
    }, 90_000)

    it.each([
      ['initial publication', false, 'a', 81],
      ['durable resume', true, 'b', 82],
    ] as const)('preserves a concurrent Git index publication during %s', async (
      _name,
      resume,
      payloadDigit,
      admissionRevision,
    ) => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const concurrentPath = join(root, 'concurrent.txt')
      await writeFile(concurrentPath, 'concurrent index publication\n')
      const tracked = scratchRootTrackingNodeAdapter()
      const state = {
        active: false,
        injected: false,
        lockLinks: 0,
        publicationRenames: 0,
        concurrentIndex: undefined as Buffer | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async link(from, to) {
          if (state.active && !state.injected && to === lockPath && from.endsWith('.pin')) {
            state.injected = true
            await git(root, 'add', '--', 'concurrent.txt')
            state.concurrentIndex = await readFile(indexPath)
          }
          if (to === lockPath) state.lockLinks += 1
          await tracked.link(from, to)
        },
        async rename(from, to) {
          if (from === lockPath && to === indexPath) state.publicationRenames += 1
          await tracked.rename(from, to)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const retained = resume
        ? await captureDurableNotStartedStage(
          execution,
          root,
          signal,
          payloadDigit,
          admissionRevision,
        )
        : await preparedStage(execution, root, signal, payloadDigit, admissionRevision)
      state.active = true

      const started = await execution.startOperation(
        retained.prepared.preparation.operation,
        retained.prepared.acceptance,
        signal,
      )

      expect(started).toMatchObject({
        ok: true,
        snapshot: {
          state: 'failed',
          failure: { reason: 'observation-stale' },
          effect: 'none',
        },
      })
      expect(state).toMatchObject({
        active: true,
        injected: true,
        lockLinks: resume ? 2 : 1,
        publicationRenames: 0,
      })
      expect(state.concurrentIndex).toBeDefined()
      await expect(readFile(indexPath)).resolves.toEqual(state.concurrentIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('concurrent.txt')
      expect(await gitText(root, 'diff', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it.each([
      ['Stage', 'stage-files', '1', 86],
      ['Unstage', 'unstage-files', '2', 87],
    ] as const)('rejects a durable %s when only the shared index mode drifts', async (
      _name,
      operation,
      payloadDigit,
      admissionRevision,
    ) => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const tracked = scratchRootTrackingNodeAdapter()
      const initial = await stat(indexPath, { bigint: true })
      const initialMode = Number(initial.mode & 0o777n)
      const driftedMode = initialMode === 0o600 ? 0o644 : 0o600
      const state = { drifted: false, publicationRenames: 0 }
      const exposeIndexMode = <T extends { readonly mode: bigint }>(info: T): T => {
        if (!state.drifted) return info
        Object.defineProperty(info, 'mode', {
          value: (info.mode & ~0o777n) | BigInt(driftedMode),
          enumerable: true,
          configurable: true,
        })
        return info
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        platform: 'linux',
        async lstat(path) {
          const info = await tracked.lstat(path)
          return path === indexPath ? exposeIndexMode(info) : info
        },
        async open(path, flags, mode) {
          const handle = await tracked.open(path, flags, mode)
          if (path !== indexPath || flags !== 'r') return handle
          return {
            ...handle,
            stat: async () => exposeIndexMode(await handle.stat()),
          }
        },
        async rename(from, to) {
          if (from === lockPath && to === indexPath) state.publicationRenames += 1
          await tracked.rename(from, to)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const retained = operation === 'stage-files'
        ? await captureDurableNotStartedStage(execution, root, signal, payloadDigit, admissionRevision)
        : await captureDurableNotStartedUnstage(execution, root, signal, payloadDigit, admissionRevision)
      state.drifted = true

      expect(await execution.startOperation(
        retained.prepared.preparation.operation,
        retained.prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: true,
        snapshot: {
          state: 'failed',
          failure: { reason: 'observation-stale' },
          effect: 'none',
        },
      })

      expect(state).toEqual({ drifted: true, publicationRenames: 0 })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it('protects a Windows index pin before bytes and publishes through secure replacement', async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const tracked = scratchRootTrackingNodeAdapter()
      const calls: string[] = []
      let publicationRenames = 0
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        platform: 'win32',
        async copyFileDacl(source, destination) {
          calls.push(`copy:${source}`)
          expect(source).toBe(indexPath)
          await expect(readFile(destination)).resolves.toEqual(Buffer.alloc(0))
        },
        async replaceFile(replaced, replacement) {
          calls.push(`replace:${replaced}`)
          expect(replacement).toBe(lockPath)
          await tracked.rename(replacement, replaced)
        },
        async rename(from, to) {
          if (from === lockPath && to === indexPath) publicationRenames += 1
          await tracked.rename(from, to)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, 'c', 83)

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })

      expect(calls).toEqual([`copy:${indexPath}`, `replace:${indexPath}`])
      expect(publicationRenames).toBe(0)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('does not replace an index created after the missing-index lock check', async () => {
      const root = await unbornRepository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const tracked = scratchRootTrackingNodeAdapter()
      const foreignIndex = Buffer.from('concurrent index publication\n', 'utf8')
      const state = { active: false, injected: false, publicationLinks: 0 }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async link(from, to) {
          if (state.active && from === lockPath && to === indexPath) {
            state.publicationLinks += 1
            if (!state.injected) {
              await writeFile(indexPath, foreignIndex, { flag: 'wx' })
              await tracked.syncDirectory(dirname(indexPath))
              state.injected = true
            }
          }
          await tracked.link(from, to)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedMissingIndexStage(execution, root, signal, 'd')
      state.active = true

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: true,
        snapshot: { state: 'reconciliation-required', reason: 'evidence-conflict' },
      })

      expect(state).toEqual({ active: true, injected: true, publicationLinks: 1 })
      await expect(readFile(indexPath)).resolves.toEqual(foreignIndex)
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('recovers a missing-index hard-link publication after acknowledgement and cleanup loss', async () => {
      const root = await unbornRepository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const tracked = scratchRootTrackingNodeAdapter()
      const acknowledgementLoss = new Error('injected missing-index link acknowledgement loss')
      const cleanupFailure = Object.assign(new Error('injected owned-lock cleanup failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'unlink',
        path: lockPath,
      })
      const state = {
        active: false,
        acknowledgementLost: false,
        cleanupFailed: false,
        publicationLinks: 0,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        async link(from, to) {
          await tracked.link(from, to)
          if (state.active && from === lockPath && to === indexPath && !state.acknowledgementLost) {
            state.publicationLinks += 1
            state.acknowledgementLost = true
            throw acknowledgementLoss
          }
        },
        async rm(path, options) {
          if (state.active && path === lockPath && !state.cleanupFailed) {
            state.cleanupFailed = true
            throw cleanupFailure
          }
          await tracked.rm(path, options)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedMissingIndexStage(execution, root, signal, 'e')
      state.active = true

      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).rejects.toBe(cleanupFailure)

      const published = await readFile(indexPath)
      await expect(readFile(lockPath)).resolves.toEqual(published)
      const [indexInfo, lockInfo] = await Promise.all([
        stat(indexPath, { bigint: true }),
        stat(lockPath, { bigint: true }),
      ])
      expect({ device: lockInfo.dev, inode: lockInfo.ino }).toEqual({
        device: indexInfo.dev,
        inode: indexInfo.ino,
      })

      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'succeeded' })

      expect(state).toEqual({
        active: true,
        acknowledgementLost: true,
        cleanupFailed: true,
        publicationLinks: 1,
      })
      await expect(readFile(indexPath)).resolves.toEqual(published)
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    }, 120_000)

    it('does not record index publication success until its directory entry is synced', async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const tracked = scratchRootTrackingNodeAdapter()
      const syncFailure = Object.assign(new Error('injected index directory sync failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'fsync',
        path: dirname(indexPath),
      })
      const state = { active: false, publicationApplied: false, failSync: true, syncFailures: 0 }
      const node: LocalGitMutationNodeAdapter = {
        ...tracked,
        platform: 'linux',
        async rename(from, to) {
          await tracked.rename(from, to)
          if (state.active && from === lockPath && to === indexPath) state.publicationApplied = true
        },
        async syncDirectory(path) {
          if (state.active && state.publicationApplied && state.failSync && path === dirname(indexPath)) {
            state.syncFailures += 1
            throw syncFailure
          }
          await tracked.syncDirectory(path)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, 'f', 84)
      state.active = true

      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).rejects.toBe(syncFailure)
      expect(state).toMatchObject({ publicationApplied: true, syncFailures: 2 })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')

      await expect(execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).rejects.toBe(syncFailure)
      expect(state.syncFailures).toBe(3)

      state.failSync = false
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'succeeded' })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    }, 120_000)

    it('keeps a Stage retryable when the shared index lock cannot be inspected', async () => {
      const root = await repository()
      const gitDirectory = join(root, '.git')
      const indexPath = join(gitDirectory, 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const failure = Object.assign(new Error('injected index lock lstat failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'lstat',
        path: lockPath,
      })
      const state = { lockLstats: 0, injected: false, scratchOwnerCreates: 0 }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          if (path === lockPath) {
            state.lockLstats += 1
            if (state.lockLstats === 1) {
              state.injected = true
              throw failure
            }
          }
          return await localGitMutationNodeAdapter.lstat(path)
        },
        async open(path, flags, mode) {
          if (flags === 'wx' && basename(path) === 'owner') state.scratchOwnerCreates += 1
          return await localGitMutationNodeAdapter.open(path, flags, mode)
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, 'c', 43)
      const originalGitEntries = (await readdir(gitDirectory)).sort()

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'planning', revision: 2 },
      })

      expect(state).toEqual({ lockLstats: 1, injected: true, scratchOwnerCreates: 0 })
      expect((await readdir(gitDirectory)).sort()).toEqual(originalGitEntries)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await stat(indexPath, { bigint: true })).toMatchObject({
        dev: originalIndexInfo.dev,
        ino: originalIndexInfo.ino,
        mode: originalIndexInfo.mode,
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 75_000)

    it.each([
      {
        name: 'the source becomes a non-file before final mode capture',
        kind: 'nonfile',
      },
      {
        name: 'the final source/mode observation is unavailable',
        kind: 'eio',
      },
    ] as const)('keeps Stage planning retryable when stable shared-index evidence fails: $name', async ({ kind }) => {
      const root = await repository()
      const gitDirectory = join(root, '.git')
      const indexPath = join(gitDirectory, 'index')
      const lockPath = `${indexPath}.lock`
      const retainedIndexPath = `${indexPath}.retained-mode`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const failure = Object.assign(new Error('injected index mode lstat failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'lstat',
        path: indexPath,
      })
      const state = {
        sharedIndexReadOpens: 0,
        modeCaptureArmed: false,
        phaseIndexLstats: 0,
        injected: false,
        pinCreates: 0,
        scratchPath: undefined as string | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          if (!state.modeCaptureArmed || path !== indexPath) {
            return await localGitMutationNodeAdapter.lstat(path)
          }
          state.phaseIndexLstats += 1
          state.modeCaptureArmed = false
          state.injected = true
          if (kind === 'eio') throw failure
          await localGitMutationNodeAdapter.rename(indexPath, retainedIndexPath)
          await mkdir(indexPath)
          return await localGitMutationNodeAdapter.lstat(indexPath)
        },
        async open(path, flags, mode) {
          if (flags === 'wx' && basename(path) === 'owner'
            && basename(dirname(path)).startsWith('saki-host-operation-')) {
            state.scratchPath ??= dirname(path)
            if (!roots.includes(dirname(path))) roots.push(dirname(path))
          } else if (flags === 'wx' && path.endsWith('.pin')) {
            state.pinCreates += 1
          }
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (flags === 'r' && path === indexPath) {
            state.sharedIndexReadOpens += 1
            if (state.sharedIndexReadOpens === 1) {
              state.modeCaptureArmed = true
              state.phaseIndexLstats = 0
            }
          }
          return handle
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(
        execution,
        root,
        signal,
        kind === 'nonfile' ? 'd' : 'e',
        kind === 'nonfile' ? 44 : 45,
      )

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'planning', revision: 2 },
      })

      expect(state).toMatchObject({
        sharedIndexReadOpens: 1,
        modeCaptureArmed: false,
        phaseIndexLstats: 1,
        injected: true,
        pinCreates: 0,
      })
      if (state.scratchPath === undefined) throw new Error('test retained no Stage scratch path')
      await expect(stat(state.scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      if (kind === 'nonfile') {
        expect((await stat(indexPath)).isDirectory()).toBe(true)
        expect(await readFile(retainedIndexPath)).toEqual(originalIndex)
        expect(await stat(retainedIndexPath, { bigint: true })).toMatchObject({
          dev: originalIndexInfo.dev,
          ino: originalIndexInfo.ino,
          mode: originalIndexInfo.mode,
        })
        await rm(indexPath, { recursive: true, force: false })
        await rename(retainedIndexPath, indexPath)
      } else {
        expect(await readFile(indexPath)).toEqual(originalIndex)
        expect(await stat(indexPath, { bigint: true })).toMatchObject({
          dev: originalIndexInfo.dev,
          ino: originalIndexInfo.ino,
          mode: originalIndexInfo.mode,
        })
      }
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await stat(indexPath, { bigint: true })).toMatchObject({
        dev: originalIndexInfo.dev,
        ino: originalIndexInfo.ino,
        mode: originalIndexInfo.mode,
      })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 90_000)

    it('rejects a resumed Stage when its pin directory changes device before lock acquisition', async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const boundary = indexPublicationBoundaryNodeAdapter(indexPath, 'parent-device-drift')
      const execution = await provider(root, { node: boundary.node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        '5',
        75,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      const world = await captureUnpublishedGitMutationWorld(root, indexPath, lockPath)
      const pinBytes = await readFile(plan.pin.path)
      boundary.state.pinPath = plan.pin.path
      boundary.state.active = true

      const resumed = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      ).finally(() => { boundary.state.active = false })

      expect(resumed).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })
      expect(boundary.state).toMatchObject({
        injected: true,
        pinReadClosed: true,
        linkAttempts: 0,
        successfulLinks: 0,
        lockRemovals: 0,
        publicationRenames: 0,
      })
      await expectUnpublishedGitMutationWorld(world)
      await expect(readFile(plan.pin.path)).resolves.toEqual(pinBytes)
      const retainedPin = await stat(plan.pin.path, { bigint: true })
      expect({ device: retainedPin.dev.toString(), inode: retainedPin.ino.toString() }).toEqual(plan.pin.identity)
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it('rejects a resumed Stage when its pin pathname is replaced after linking the lock', async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const boundary = indexPublicationBoundaryNodeAdapter(indexPath, 'pin-replaced-after-link')
      const execution = await provider(root, { node: boundary.node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        '6',
        76,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      const world = await captureUnpublishedGitMutationWorld(root, indexPath, lockPath)
      const pinBytes = await readFile(plan.pin.path)
      boundary.state.pinPath = plan.pin.path
      boundary.state.active = true

      const resumed = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      ).finally(() => { boundary.state.active = false })

      expect(resumed).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })
      expect(boundary.state).toMatchObject({
        injected: true,
        linkAttempts: 1,
        successfulLinks: 1,
        lockRemovals: 1,
        publicationRenames: 0,
      })
      expect(boundary.state.foreign).toMatchObject({
        replaced: true,
        foreignPath: plan.pin.path,
      })
      await expectUnpublishedGitMutationWorld(world)
      await expect(readFile(plan.pin.path)).resolves.toEqual(pinBytes)
      const foreignPin = await stat(plan.pin.path, { bigint: true })
      expect({ device: foreignPin.dev.toString(), inode: foreignPin.ino.toString() }).toEqual(
        boundary.state.foreign.foreignIdentity,
      )
      expect(boundary.state.foreign.foreignIdentity).not.toEqual(plan.pin.identity)
      const retainedOriginalPath = boundary.state.foreign.retainedOriginalPath
      if (retainedOriginalPath === undefined) throw new Error('test retained no original index pin')
      const retainedOriginal = await stat(retainedOriginalPath, { bigint: true })
      expect({ device: retainedOriginal.dev.toString(), inode: retainedOriginal.ino.toString() }).toEqual(
        plan.pin.identity,
      )
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()

      await unlink(plan.pin.path)
      await rename(retainedOriginalPath, plan.pin.path)
      await localGitMutationNodeAdapter.syncDirectory(dirname(plan.pin.path))
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(retainedOriginalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it('maps a vanished index pin link source to unavailable instead of lock contention', async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const boundary = indexPublicationBoundaryNodeAdapter(indexPath, 'link-source-missing')
      const execution = await provider(root, { node: boundary.node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        '7',
        77,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      const world = await captureUnpublishedGitMutationWorld(root, indexPath, lockPath)
      const pinBytes = await readFile(plan.pin.path)
      boundary.state.pinPath = plan.pin.path
      boundary.state.active = true

      const resumed = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      ).finally(() => { boundary.state.active = false })

      expect(resumed).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })
      expect(boundary.state).toMatchObject({
        injected: true,
        linkAttempts: 1,
        successfulLinks: 0,
        lockRemovals: 0,
        publicationRenames: 0,
        linkError: { code: 'ENOENT' },
      })
      await expectUnpublishedGitMutationWorld(world)
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      const retainedOriginalPath = boundary.state.retainedOriginalPath
      if (retainedOriginalPath === undefined) throw new Error('test retained no vanished link source')
      await expect(readFile(retainedOriginalPath)).resolves.toEqual(pinBytes)
      const retainedOriginal = await stat(retainedOriginalPath, { bigint: true })
      expect({ device: retainedOriginal.dev.toString(), inode: retainedOriginal.ino.toString() }).toEqual(
        plan.pin.identity,
      )
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()

      await rename(retainedOriginalPath, plan.pin.path)
      await localGitMutationNodeAdapter.syncDirectory(dirname(plan.pin.path))
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(retainedOriginalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it.each([
      {
        name: 'reports an owned lock rebuilt after removal',
        kind: 'after-state-recreate',
        payloadDigit: 'f',
        admissionRevision: 46,
        expectedLockReadCloses: 0,
        expectedFinalIdentityLstats: 0,
        expectedProductionRemovals: 1,
      },
      {
        name: 'preserves a same-content foreign lock at the final identity check',
        kind: 'final-foreign',
        payloadDigit: '1',
        admissionRevision: 47,
        expectedLockReadCloses: 2,
        expectedFinalIdentityLstats: 1,
        expectedProductionRemovals: 0,
      },
      {
        name: 'accepts a lock removed at the final identity check',
        kind: 'final-enoent',
        payloadDigit: '2',
        admissionRevision: 48,
        expectedLockReadCloses: 2,
        expectedFinalIdentityLstats: 1,
        expectedProductionRemovals: 0,
      },
      {
        name: 'surfaces an unavailable final lock identity check',
        kind: 'final-eio',
        payloadDigit: '3',
        admissionRevision: 49,
        expectedLockReadCloses: 2,
        expectedFinalIdentityLstats: 1,
        expectedProductionRemovals: 0,
      },
    ] as const)('$name while releasing a resumed Stage', async ({
      kind,
      payloadDigit,
      admissionRevision,
      expectedLockReadCloses,
      expectedFinalIdentityLstats,
      expectedProductionRemovals,
    }) => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const primaryFailure = new Error(`injected ${kind} attempting persistence failure`)
      const finalFailure = Object.assign(new Error('injected final lock lstat failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'lstat',
        path: lockPath,
      })
      const foreign: SameContentReplacementState = { replaced: false }
      const state = {
        armed: false,
        finalIdentityArmed: false,
        injected: false,
        lockReadCloses: 0,
        finalIdentityLstats: 0,
        productionLockRemovals: 0,
        pinPath: undefined as string | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          if (kind === 'after-state-recreate' || !state.finalIdentityArmed || path !== lockPath) {
            return await localGitMutationNodeAdapter.lstat(path)
          }
          state.finalIdentityLstats += 1
          state.finalIdentityArmed = false
          state.injected = true
          switch (kind) {
            case 'final-foreign':
              await replaceFileWithSameContents(foreign, path)
              return await localGitMutationNodeAdapter.lstat(path)
            case 'final-enoent':
              await localGitMutationNodeAdapter.rm(path, { force: false })
              return await localGitMutationNodeAdapter.lstat(path)
            case 'final-eio':
              throw finalFailure
          }
        },
        async open(path, flags, mode) {
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (!state.armed || kind === 'after-state-recreate' || path !== lockPath || flags !== 'r') return handle
          return {
            ...handle,
            async close() {
              await handle.close()
              state.lockReadCloses += 1
              if (state.lockReadCloses === 2) {
                state.finalIdentityArmed = true
                state.finalIdentityLstats = 0
              }
            },
          }
        },
        async rm(path, options) {
          if (!state.armed || path !== lockPath) {
            await localGitMutationNodeAdapter.rm(path, options)
            return
          }
          state.productionLockRemovals += 1
          await localGitMutationNodeAdapter.rm(path, options)
          if (kind === 'after-state-recreate' && !state.injected) {
            if (state.pinPath === undefined) throw new Error('test retained no index pin path')
            await localGitMutationNodeAdapter.link(state.pinPath, path)
            await localGitMutationNodeAdapter.syncDirectory(dirname(path))
            state.injected = true
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        payloadDigit,
        admissionRevision,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      state.pinPath = plan.pin.path
      const pinBytes = await readFile(plan.pin.path)
      const persistence = operationPersistence(execution)
      persistence.replace(async (record) => {
        if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
          && record.effectPlan.publication === 'attempting') {
          state.armed = true
          state.finalIdentityArmed = false
          state.lockReadCloses = 0
          state.finalIdentityLstats = 0
          throw primaryFailure
        }
        await persistence.original(record)
      })

      let caught: unknown
      try {
        await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } catch (error) {
        caught = error
      } finally {
        persistence.restore()
      }
      state.armed = false

      if (kind === 'after-state-recreate') {
        expect(caught).toMatchObject({
          reason: 'unavailable',
          message: 'Saki Git mutation is temporarily unavailable',
        })
        expect(caught).not.toBe(primaryFailure)
      } else if (kind === 'final-eio') {
        expect(caught).toBe(finalFailure)
      } else {
        expect(caught).toBe(primaryFailure)
      }
      expect(state).toMatchObject({
        injected: true,
        lockReadCloses: expectedLockReadCloses,
        finalIdentityLstats: expectedFinalIdentityLstats,
        productionLockRemovals: expectedProductionRemovals,
      })
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await stat(indexPath, { bigint: true })).toMatchObject({
        dev: originalIndexInfo.dev,
        ino: originalIndexInfo.ino,
        mode: originalIndexInfo.mode,
      })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      expect(await readFile(plan.pin.path)).toEqual(pinBytes)
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })

      if (kind === 'final-enoent') {
        await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(await readFile(lockPath)).toEqual(pinBytes)
        const lockInfo = await stat(lockPath, { bigint: true })
        expect(Number(lockInfo.mode & 0o777n)).toBe(plan.pin.mode)
        expect(lockInfo.size).toBe(BigInt(plan.pin.byteLength))
        const lockIdentity = { device: lockInfo.dev.toString(), inode: lockInfo.ino.toString() }
        if (kind === 'final-foreign') {
          expect(foreign).toMatchObject({ replaced: true, foreignPath: lockPath })
          expect(lockIdentity).toEqual(foreign.foreignIdentity)
          expect(lockIdentity).not.toEqual(plan.pin.identity)
          if (foreign.retainedOriginalPath === undefined) {
            throw new Error('test retained no original owned lock')
          }
          const retained = await stat(foreign.retainedOriginalPath, { bigint: true })
          expect({ device: retained.dev.toString(), inode: retained.ino.toString() }).toEqual(plan.pin.identity)
          await unlink(lockPath)
          await rename(foreign.retainedOriginalPath, lockPath)
        } else {
          expect(lockIdentity).toEqual(plan.pin.identity)
        }
      }

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      if (foreign.retainedOriginalPath !== undefined) {
        await expect(stat(foreign.retainedOriginalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }, 120_000)
  })

  describe('owned file Node failure boundaries', () => {
    it.each([
      { name: 'caller abort', kind: 'abort', payloadDigit: '1', admissionRevision: 62 },
      { name: 'filesystem failure', kind: 'eio', payloadDigit: '2', admissionRevision: 63 },
    ] as const)('closes a linked Stage lock after an initial $name', async ({
      kind,
      payloadDigit,
      admissionRevision,
    }) => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const controller = new AbortController()
      const abortReason = new Error('linked Stage lock initial inspection aborted')
      const failure = Object.assign(new Error('injected linked Stage lock initial lstat failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'lstat',
        path: lockPath,
      })
      const state = {
        armed: false,
        injected: false,
        successfulLinks: 0,
        phaseLockLstats: 0,
        pinPath: undefined as string | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async link(from, to) {
          await localGitMutationNodeAdapter.link(from, to)
          if (from === state.pinPath && to === lockPath) {
            state.successfulLinks += 1
            state.armed = true
          }
        },
        async lstat(path) {
          if (!state.armed || state.injected || path !== lockPath) {
            return await localGitMutationNodeAdapter.lstat(path)
          }
          state.armed = false
          state.injected = true
          state.phaseLockLstats += 1
          const info = await localGitMutationNodeAdapter.lstat(path)
          if (kind === 'abort') {
            controller.abort(abortReason)
            return info
          }
          throw failure
        },
      }
      const execution = await provider(root, { node })
      const setupSignal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        setupSignal,
        payloadDigit,
        admissionRevision,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      state.pinPath = plan.pin.path
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const pinBytes = await readFile(plan.pin.path)

      let caught: unknown
      let result: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>> | undefined
      try {
        result = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          controller.signal,
        )
      } catch (error) {
        caught = error
      }

      if (kind === 'abort') {
        expect(caught).toBe(abortReason)
        expect(result).toBeUndefined()
      } else {
        expect(caught).toBeUndefined()
        expect(result).toMatchObject({
          ok: false,
          reason: 'unavailable',
          snapshot: { state: 'publishing', revision: durable.snapshot.revision },
        })
      }
      expect(state).toMatchObject({
        armed: false,
        injected: true,
        successfulLinks: 1,
        phaseLockLstats: 1,
      })
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        setupSignal,
      )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(plan.pin.path)).toEqual(pinBytes)
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        setupSignal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it('closes a linked Stage lock whose metadata drifts after the extra-byte probe', async () => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const state = {
        armed: false,
        injected: false,
        successfulLinks: 0,
        targetHandles: 0,
        targetHandleCloses: 0,
        extraProbeReads: 0,
        extraProbeBytesRead: undefined as number | undefined,
        pinPath: undefined as string | undefined,
        pinByteLength: undefined as number | undefined,
        before: undefined as { readonly device: string; readonly inode: string; readonly mtimeNs: bigint } | undefined,
        after: undefined as { readonly device: string; readonly inode: string; readonly mtimeNs: bigint } | undefined,
        postCloseStat: undefined as (() => Promise<unknown>) | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async link(from, to) {
          await localGitMutationNodeAdapter.link(from, to)
          if (from === state.pinPath && to === lockPath) {
            state.successfulLinks += 1
            state.armed = true
          }
        },
        async open(path, flags, mode) {
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (!state.armed || state.injected || path !== lockPath || flags !== 'r') return handle
          state.targetHandles += 1
          state.postCloseStat = async () => await handle.stat()
          return {
            ...handle,
            async read(buffer, offset, length, position) {
              const read = await handle.read(buffer, offset, length, position)
              if (!state.injected && position === state.pinByteLength && length === 1) {
                state.extraProbeReads += 1
                state.extraProbeBytesRead = read.bytesRead
                const before = await stat(path, { bigint: true })
                state.before = {
                  device: before.dev.toString(),
                  inode: before.ino.toString(),
                  mtimeNs: before.mtimeNs,
                }
                await utimes(path, new Date(946_684_802_000), new Date(946_684_803_000))
                const after = await stat(path, { bigint: true })
                state.after = {
                  device: after.dev.toString(),
                  inode: after.ino.toString(),
                  mtimeNs: after.mtimeNs,
                }
                state.armed = false
                state.injected = true
              }
              return read
            },
            async close() {
              await handle.close()
              state.targetHandleCloses += 1
            },
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, '3', 64)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      state.pinPath = plan.pin.path
      state.pinByteLength = plan.pin.byteLength
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const pinBytes = await readFile(plan.pin.path)

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })

      expect(state).toMatchObject({
        armed: false,
        injected: true,
        successfulLinks: 1,
        targetHandles: 1,
        targetHandleCloses: 1,
        extraProbeReads: 1,
        extraProbeBytesRead: 0,
      })
      expect(state.before).toBeDefined()
      expect(state.after).toBeDefined()
      expect({ device: state.after?.device, inode: state.after?.inode }).toEqual({
        device: state.before?.device,
        inode: state.before?.inode,
      })
      expect(state.after?.mtimeNs).not.toBe(state.before?.mtimeNs)
      if (state.postCloseStat === undefined) throw new Error('test retained no linked Stage lock handle')
      await expect(state.postCloseStat()).rejects.toThrow()
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(plan.pin.path)).toEqual(pinBytes)
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it.each([
      { name: 'caller abort from a real opened-file stat', kind: 'abort', payloadDigit: '4', admissionRevision: 65 },
      { name: 'real pathname disappearance before open', kind: 'enoent', payloadDigit: '5', admissionRevision: 66 },
      { name: 'filesystem failure after a real opened-file stat', kind: 'eio', payloadDigit: '6', admissionRevision: 67 },
    ] as const)('handles a linked Stage lock after $name', async ({
      kind,
      payloadDigit,
      admissionRevision,
    }) => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-opened-lock-boundary-'))
      roots.push(holdingRoot)
      const retainedLockPath = join(holdingRoot, 'linked-lock')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const controller = new AbortController()
      const abortReason = new Error('opened Stage lock inspection aborted')
      const failure = Object.assign(new Error('injected opened Stage lock inspection failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'fstat',
        path: lockPath,
      })
      const state = {
        armed: false,
        injected: false,
        successfulLinks: 0,
        targetHandles: 0,
        openedStatCalls: 0,
        targetHandleCloses: 0,
        retainedLock: false,
        pinPath: undefined as string | undefined,
        postCloseStat: undefined as (() => Promise<unknown>) | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async link(from, to) {
          await localGitMutationNodeAdapter.link(from, to)
          if (from === state.pinPath && to === lockPath) {
            state.successfulLinks += 1
            state.armed = true
          }
        },
        async open(path, flags, mode) {
          if (!state.armed || state.injected || path !== lockPath || flags !== 'r') {
            return await localGitMutationNodeAdapter.open(path, flags, mode)
          }
          state.armed = false
          state.injected = true
          if (kind === 'enoent') {
            await localGitMutationNodeAdapter.rename(path, retainedLockPath)
            state.retainedLock = true
            return await localGitMutationNodeAdapter.open(path, flags, mode)
          }
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          state.targetHandles += 1
          state.postCloseStat = async () => await handle.stat()
          return {
            ...handle,
            async stat() {
              state.openedStatCalls += 1
              if (kind === 'abort') {
                const info = await handle.stat()
                controller.abort(abortReason)
                return info
              }
              await handle.stat()
              throw failure
            },
            async close() {
              await handle.close()
              state.targetHandleCloses += 1
            },
          }
        },
      }
      const execution = await provider(root, { node })
      const setupSignal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        setupSignal,
        payloadDigit,
        admissionRevision,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      state.pinPath = plan.pin.path
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const pinBytes = await readFile(plan.pin.path)

      let caught: unknown
      let result: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>> | undefined
      try {
        result = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          controller.signal,
        )
      } catch (error) {
        caught = error
      }

      if (kind === 'abort') {
        expect(caught).toBe(abortReason)
        expect(result).toBeUndefined()
      } else {
        expect(caught).toBeUndefined()
        expect(result).toMatchObject({
          ok: false,
          reason: 'unavailable',
          snapshot: { state: 'publishing', revision: durable.snapshot.revision },
        })
      }
      expect(state).toMatchObject({
        armed: false,
        injected: true,
        successfulLinks: 1,
        targetHandles: kind === 'enoent' ? 0 : 1,
        openedStatCalls: kind === 'enoent' ? 0 : 1,
        targetHandleCloses: kind === 'enoent' ? 0 : 1,
        retainedLock: kind === 'enoent',
      })
      if (kind === 'enoent') {
        expect(state.postCloseStat).toBeUndefined()
      } else {
        if (state.postCloseStat === undefined) throw new Error('test retained no opened Stage lock handle')
        await expect(state.postCloseStat()).rejects.toThrow()
      }
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      if (kind === 'enoent') {
        expect(await readFile(retainedLockPath)).toEqual(pinBytes)
        const retained = await stat(retainedLockPath, { bigint: true })
        expect({ device: retained.dev.toString(), inode: retained.ino.toString() }).toEqual(plan.pin.identity)
      } else {
        await expect(stat(retainedLockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(await readFile(plan.pin.path)).toEqual(pinBytes)
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

      if (kind === 'enoent') await unlink(retainedLockPath)
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        setupSignal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(retainedLockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it.each([
      { name: 'symbolic link', kind: 'symlink', payloadDigit: '7', admissionRevision: 68 },
      { name: 'directory', kind: 'directory', payloadDigit: '8', admissionRevision: 69 },
    ] as const)('preserves a real $name that replaces a linked Stage lock', async ({
      kind,
      payloadDigit,
      admissionRevision,
    }) => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-linked-lock-kind-boundary-'))
      roots.push(holdingRoot)
      const retainedLockPath = join(holdingRoot, 'owned-lock')
      const symlinkTargetPath = join(holdingRoot, 'symlink-target')
      const symlinkSentinelPath = join(symlinkTargetPath, 'sentinel')
      const symlinkSentinel = Buffer.from('linked lock symlink target\n', 'utf8')
      if (kind === 'symlink') {
        await mkdir(symlinkTargetPath)
        await writeFile(symlinkSentinelPath, symlinkSentinel, { flag: 'wx' })
      }
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const state = {
        armed: false,
        injected: false,
        successfulLinks: 0,
        phaseLockLstats: 0,
        pinPath: undefined as string | undefined,
        replacementIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async link(from, to) {
          await localGitMutationNodeAdapter.link(from, to)
          if (from === state.pinPath && to === lockPath) {
            state.successfulLinks += 1
            state.armed = true
          }
        },
        async lstat(path) {
          if (!state.armed || state.injected || path !== lockPath) {
            return await localGitMutationNodeAdapter.lstat(path)
          }
          state.armed = false
          state.injected = true
          state.phaseLockLstats += 1
          await localGitMutationNodeAdapter.rename(path, retainedLockPath)
          if (kind === 'symlink') {
            await symlink(symlinkTargetPath, path, process.platform === 'win32' ? 'junction' : 'dir')
          } else {
            await mkdir(path)
          }
          const replacement = await localGitMutationNodeAdapter.lstat(path)
          state.replacementIdentity = {
            device: replacement.dev.toString(),
            inode: replacement.ino.toString(),
          }
          return replacement
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        payloadDigit,
        admissionRevision,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      state.pinPath = plan.pin.path
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const pinBytes = await readFile(plan.pin.path)

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })

      expect(state).toMatchObject({
        armed: false,
        injected: true,
        successfulLinks: 1,
        phaseLockLstats: 1,
      })
      const replacement = await localGitMutationNodeAdapter.lstat(lockPath)
      expect({ device: replacement.dev.toString(), inode: replacement.ino.toString() }).toEqual(
        state.replacementIdentity,
      )
      expect(state.replacementIdentity).not.toEqual(plan.pin.identity)
      if (kind === 'symlink') {
        expect(replacement.isSymbolicLink()).toBe(true)
        expect(await readFile(symlinkSentinelPath)).toEqual(symlinkSentinel)
      } else {
        expect(replacement.isDirectory()).toBe(true)
        expect(replacement.isSymbolicLink()).toBe(false)
      }
      const retained = await stat(retainedLockPath, { bigint: true })
      expect({ device: retained.dev.toString(), inode: retained.ino.toString() }).toEqual(plan.pin.identity)
      expect(await readFile(retainedLockPath)).toEqual(pinBytes)
      expect(await readFile(plan.pin.path)).toEqual(pinBytes)
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

      if (kind === 'symlink') {
        await unlink(lockPath)
        expect(await readFile(symlinkSentinelPath)).toEqual(symlinkSentinel)
      } else {
        await localGitMutationNodeAdapter.rmdir(lockPath)
      }
      await rename(retainedLockPath, lockPath)
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(retainedLockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      if (kind === 'symlink') expect(await readFile(symlinkSentinelPath)).toEqual(symlinkSentinel)
    }, 120_000)
  })

  describe('bounded index read Node failure boundaries', () => {
    it.each([
      { name: 'filesystem failure', kind: 'eio', payloadDigit: '9', admissionRevision: 70 },
      { name: 'plain failure', kind: 'plain', payloadDigit: 'a', admissionRevision: 71 },
    ] as const)('preserves a durable Stage after an initial bounded-index $name', async ({
      kind,
      payloadDigit,
      admissionRevision,
    }) => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const systemFailure = Object.assign(new Error('injected bounded index initial lstat failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'lstat',
        path: indexPath,
      })
      const plainFailure = new Error('injected plain bounded index initial failure')
      const state = { armed: false, injected: false, phaseIndexLstats: 0 }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async lstat(path) {
          if (!state.armed || state.injected || path !== indexPath) {
            return await localGitMutationNodeAdapter.lstat(path)
          }
          state.armed = false
          state.injected = true
          state.phaseIndexLstats += 1
          if (kind === 'eio') throw systemFailure
          throw plainFailure
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        payloadDigit,
        admissionRevision,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const pinBytes = await readFile(plan.pin.path)
      state.armed = true

      let caught: unknown
      let result: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>> | undefined
      try {
        result = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } catch (error) {
        caught = error
      }

      if (kind === 'plain') {
        expect(caught).toBe(plainFailure)
        expect(result).toBeUndefined()
      } else {
        expect(caught).toBeUndefined()
        expect(result).toMatchObject({
          ok: false,
          reason: 'unavailable',
          snapshot: { state: 'publishing', revision: durable.snapshot.revision },
        })
      }
      expect(state).toEqual({ armed: false, injected: true, phaseIndexLstats: 1 })
      expect(await execution.inspectOperation(
        prepared.preparation.operation,
        signal,
      )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await stat(indexPath, { bigint: true })).toMatchObject({
        dev: originalIndexInfo.dev,
        ino: originalIndexInfo.ino,
        mode: originalIndexInfo.mode,
      })
      expect(await readFile(plan.pin.path)).toEqual(pinBytes)
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it('preserves both index pathnames when a bounded open sees a real inode replacement', async () => {
      const root = await repository()
      const holdingRoot = await mkdtemp(join(tmpdir(), 'saki-bounded-index-replacement-'))
      roots.push(holdingRoot)
      const retainedIndexPath = join(holdingRoot, 'owned-index')
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const state = {
        armed: false,
        injected: false,
        phaseIndexOpens: 0,
        targetHandleCloses: 0,
        originalBytes: undefined as Buffer | undefined,
        originalMode: undefined as number | undefined,
        replacementIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
        postCloseStat: undefined as (() => Promise<unknown>) | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async open(path, flags, mode) {
          if (!state.armed || state.injected || path !== indexPath || flags !== 'r') {
            return await localGitMutationNodeAdapter.open(path, flags, mode)
          }
          if (state.originalBytes === undefined || state.originalMode === undefined) {
            throw new Error('test retained no original bounded index')
          }
          state.armed = false
          state.injected = true
          state.phaseIndexOpens += 1
          await localGitMutationNodeAdapter.rename(path, retainedIndexPath)
          await writeFile(path, state.originalBytes, {
            flag: 'wx',
            mode: state.originalMode,
          })
          const replacement = await stat(path, { bigint: true })
          state.replacementIdentity = {
            device: replacement.dev.toString(),
            inode: replacement.ino.toString(),
          }
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          state.postCloseStat = async () => await handle.stat()
          return {
            ...handle,
            async close() {
              await handle.close()
              state.targetHandleCloses += 1
            },
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(execution, root, signal, 'b', 72)
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const pinBytes = await readFile(plan.pin.path)
      state.originalBytes = originalIndex
      state.originalMode = Number(originalIndexInfo.mode & 0o777n)
      state.armed = true

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({
        ok: false,
        reason: 'unavailable',
        snapshot: { state: 'publishing', revision: durable.snapshot.revision },
      })

      expect(state).toMatchObject({
        armed: false,
        injected: true,
        phaseIndexOpens: 1,
        targetHandleCloses: 1,
      })
      if (state.postCloseStat === undefined) throw new Error('test retained no replacement index handle')
      await expect(state.postCloseStat()).rejects.toThrow()
      const replacement = await stat(indexPath, { bigint: true })
      expect({ device: replacement.dev.toString(), inode: replacement.ino.toString() }).toEqual(
        state.replacementIdentity,
      )
      expect(state.replacementIdentity).not.toEqual({
        device: originalIndexInfo.dev.toString(),
        inode: originalIndexInfo.ino.toString(),
      })
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(Number(replacement.mode & 0o777n)).toBe(state.originalMode)
      const retained = await stat(retainedIndexPath, { bigint: true })
      expect({ dev: retained.dev, ino: retained.ino, mode: retained.mode }).toEqual({
        dev: originalIndexInfo.dev,
        ino: originalIndexInfo.ino,
        mode: originalIndexInfo.mode,
      })
      expect(await readFile(retainedIndexPath)).toEqual(originalIndex)
      expect(await readFile(plan.pin.path)).toEqual(pinBytes)
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

      await unlink(indexPath)
      await rename(retainedIndexPath, indexPath)
      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(retainedIndexPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)

    it.each([
      { name: 'filesystem failure', kind: 'eio', payloadDigit: 'c', admissionRevision: 73 },
      { name: 'plain failure', kind: 'plain', payloadDigit: 'd', admissionRevision: 74 },
    ] as const)('closes a bounded index handle after an opened $name', async ({
      kind,
      payloadDigit,
      admissionRevision,
    }) => {
      const root = await repository()
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const systemFailure = Object.assign(new Error('injected bounded index opened stat failure'), {
        code: 'EIO',
        errno: -5,
        syscall: 'fstat',
        path: indexPath,
      })
      const plainFailure = new Error('injected plain bounded index opened failure')
      const state = {
        armed: false,
        injected: false,
        phaseIndexOpens: 0,
        openedStatCalls: 0,
        targetHandleCloses: 0,
        postCloseStat: undefined as (() => Promise<unknown>) | undefined,
      }
      const node: LocalGitMutationNodeAdapter = {
        ...localGitMutationNodeAdapter,
        async open(path, flags, mode) {
          const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
          if (!state.armed || state.injected || path !== indexPath || flags !== 'r') return handle
          state.armed = false
          state.injected = true
          state.phaseIndexOpens += 1
          state.postCloseStat = async () => await handle.stat()
          return {
            ...handle,
            async stat() {
              state.openedStatCalls += 1
              await handle.stat()
              if (kind === 'eio') throw systemFailure
              throw plainFailure
            },
            async close() {
              await handle.close()
              state.targetHandleCloses += 1
            },
          }
        },
      }
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared, durable } = await captureDurableNotStartedStage(
        execution,
        root,
        signal,
        payloadDigit,
        admissionRevision,
      )
      if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const plan = durable.effectPlan
      const parent = await gitText(root, 'rev-parse', 'HEAD')
      const originalIndex = await readFile(indexPath)
      const originalIndexInfo = await stat(indexPath, { bigint: true })
      const pinBytes = await readFile(plan.pin.path)
      state.armed = true

      let caught: unknown
      let result: Awaited<ReturnType<LocalSakiHostExecution['startOperation']>> | undefined
      try {
        result = await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )
      } catch (error) {
        caught = error
      }

      if (kind === 'plain') {
        expect(caught).toBe(plainFailure)
        expect(result).toBeUndefined()
      } else {
        expect(caught).toBeUndefined()
        expect(result).toMatchObject({
          ok: false,
          reason: 'unavailable',
          snapshot: { state: 'publishing', revision: durable.snapshot.revision },
        })
      }
      expect(state).toMatchObject({
        armed: false,
        injected: true,
        phaseIndexOpens: 1,
        openedStatCalls: 1,
        targetHandleCloses: 1,
      })
      if (state.postCloseStat === undefined) throw new Error('test retained no bounded index handle')
      await expect(state.postCloseStat()).rejects.toThrow()
      expect(await readFile(indexPath)).toEqual(originalIndex)
      expect(await stat(indexPath, { bigint: true })).toMatchObject({
        dev: originalIndexInfo.dev,
        ino: originalIndexInfo.ino,
        mode: originalIndexInfo.mode,
      })
      expect(await readFile(plan.pin.path)).toEqual(pinBytes)
      await expect(stat(plan.scratch.path)).resolves.toBeDefined()
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

      expect(await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 120_000)
  })

  describe('index pin Node failure boundaries', () => {
    it.each([
      {
        name: 'bounds four real exclusive-create collisions without consuming the operation',
        kind: 'collision-exhaustion',
      },
      {
        name: 'remains retryable when a changed pin disappears before identity cleanup',
        kind: 'complete-stat-enoent',
      },
      {
        name: 'leaves a safe pin residue when identity cleanup is unavailable',
        kind: 'cleanup-rm-failure',
      },
      {
        name: 'cleans the pin after a close acknowledgement loss',
        kind: 'close-acknowledgement-loss',
      },
    ] as const)('$name', async ({ kind }) => {
      const root = await repository()
      const { node, state } = indexPinFailureAdapter(kind)
      const execution = await provider(root, { node })
      const signal = new AbortController().signal
      const { prepared } = await preparedStage(execution, root, signal, '7', 12)
      const indexPath = join(root, '.git', 'index')
      const lockPath = `${indexPath}.lock`
      const originalIndex = await readFile(indexPath)

      if (kind === 'close-acknowledgement-loss') {
        await expect(execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).rejects.toBe(state.primaryFailure)
      } else {
        expect(await execution.startOperation(
          prepared.preparation.operation,
          prepared.acceptance,
          signal,
        )).toMatchObject({
          ok: false,
          reason: 'unavailable',
          snapshot: { state: 'planning', revision: 2 },
        })
      }

      expect(await readFile(indexPath)).toEqual(originalIndex)
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
      expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
        state: 'planning',
        revision: 2,
      })
      await expectIndexPinFaultResidue(kind, state)

      const retried = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )
      expect(retried).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
      await expectIndexPinFaultResidue(kind, state)
    }, 80_000)
  })
})

async function asHistoricalDetached(record: LocalHostOperationRecord): Promise<LocalHostOperationRecord> {
  if (record.effectPlan?.kind !== 'commit' || record.request.type !== 'commit'
    || record.request.expected.head.kind !== 'commit') {
    throw new Error('test retained no historical Commit plan')
  }
  const detachedRequest = {
    ...record.request,
    expected: {
      ...record.request.expected,
      head: { kind: 'commit' as const, objectId: record.request.expected.head.objectId },
    },
  }
  const requestFingerprint = localHostOperationRequestFingerprint(detachedRequest)
  const scratchMarker = Buffer.from(
    `saki-host-operation-scratch/v1\0${record.snapshot.operation.id}\0${requestFingerprint.digest}\0`,
    'utf8',
  )
  const indexMarker = Buffer.from(
    `saki-host-operation-index-lock/v1\0${record.snapshot.operation.id}\0${requestFingerprint.digest}\0`,
    'utf8',
  )
  await writeFile(join(record.effectPlan.scratch.path, 'owner'), scratchMarker)
  await writeFile(record.effectPlan.pin.path, indexMarker)
  const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
  return sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    ...record,
    request: detachedRequest,
    snapshot: { ...record.snapshot, requestFingerprint },
    effectPlan: {
      ...record.effectPlan,
      scratch: { ...record.effectPlan.scratch, markerDigest: digest(scratchMarker) },
      targetRef: 'HEAD',
      pin: {
        ...record.effectPlan.pin,
        digest: digest(indexMarker),
        byteLength: indexMarker.byteLength,
      },
      result: { ...record.effectPlan.result, target: { kind: 'detached-head' } },
    },
  })

}

type IndexPinFailureKind =
  | 'collision-exhaustion'
  | 'complete-stat-enoent'
  | 'cleanup-rm-failure'
  | 'close-acknowledgement-loss'

interface IndexPinFailureState {
  readonly collisions: Array<{
    readonly path: string
    readonly bytes: Buffer
    readonly identity: { readonly device: string; readonly inode: string }
  }>
  readonly primaryFailure: Error
  readonly cleanupFailure: Error
  cleanupFailed: boolean
  pinPath?: string
  residue?: {
    readonly bytes: Buffer
    readonly identity: { readonly device: string; readonly inode: string }
  }
}

function indexPinFailureAdapter(
  kind: IndexPinFailureKind,
): { readonly node: LocalGitMutationNodeAdapter; readonly state: IndexPinFailureState } {
  const state: IndexPinFailureState = {
    collisions: [],
    primaryFailure: Object.assign(new Error('injected index pin close failure'), { code: 'EIO' }),
    cleanupFailure: Object.assign(new Error('injected index pin cleanup failure'), { code: 'EACCES' }),
    cleanupFailed: false,
  }
  let statDriftInjected = false
  let cleanupRemovalInjected = false
  let cleanupFailureInjected = false
  let closeFailureInjected = false
  const node: LocalGitMutationNodeAdapter = {
    ...localGitMutationNodeAdapter,
    async open(path, flags, mode) {
      if (kind === 'collision-exhaustion' && flags === 'wx' && path.endsWith('.pin')
        && state.collisions.length < 4) {
        const collision = await localGitMutationNodeAdapter.open(path, flags, mode)
        const bytes = Buffer.from(`foreign index pin collision ${state.collisions.length}\n`, 'utf8')
        try {
          await collision.writeFile(bytes)
          await collision.sync()
        } finally {
          await collision.close()
        }
        const info = await localGitMutationNodeAdapter.lstat(path)
        state.collisions.push({
          path,
          bytes,
          identity: { device: info.dev.toString(), inode: info.ino.toString() },
        })
        return await localGitMutationNodeAdapter.open(path, flags, mode)
      }

      const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
      if (flags !== 'wx' || !path.endsWith('.pin')) return handle
      state.pinPath ??= path
      if (kind === 'close-acknowledgement-loss') {
        return {
          ...handle,
          async close() {
            await handle.close()
            if (!closeFailureInjected) {
              closeFailureInjected = true
              throw state.primaryFailure
            }
          },
        }
      }
      if (kind !== 'complete-stat-enoent' && kind !== 'cleanup-rm-failure') return handle
      return {
        ...handle,
        async stat() {
          const observed = await handle.stat()
          if (statDriftInjected || observed.size === 0n) return observed
          statDriftInjected = true
          await writeFile(path, Buffer.from([0]), { flag: 'a' })
          const changed = await handle.stat()
          state.residue = {
            bytes: await readFile(path),
            identity: { device: changed.dev.toString(), inode: changed.ino.toString() },
          }
          return changed
        },
      }
    },
    async lstat(path) {
      if (kind === 'complete-stat-enoent' && path === state.pinPath && !cleanupRemovalInjected) {
        cleanupRemovalInjected = true
        await localGitMutationNodeAdapter.rm(path, { force: false })
      }
      return await localGitMutationNodeAdapter.lstat(path)
    },
    async rm(path, options) {
      if (kind === 'cleanup-rm-failure' && path === state.pinPath && !cleanupFailureInjected) {
        cleanupFailureInjected = true
        state.cleanupFailed = true
        throw state.cleanupFailure
      }
      await localGitMutationNodeAdapter.rm(path, options)
    },
  }
  return { node, state }
}

async function expectIndexPinFaultResidue(
  kind: IndexPinFailureKind,
  state: IndexPinFailureState,
): Promise<void> {
  if (kind === 'collision-exhaustion') {
    expect(state.collisions).toHaveLength(4)
    for (const collision of state.collisions) {
      const info = await localGitMutationNodeAdapter.lstat(collision.path)
      expect({ device: info.dev.toString(), inode: info.ino.toString() }).toEqual(collision.identity)
      expect(await readFile(collision.path)).toEqual(collision.bytes)
    }
    return
  }
  if (state.pinPath === undefined) throw new Error('test retained no index pin path')
  if (kind === 'complete-stat-enoent' || kind === 'close-acknowledgement-loss') {
    await expect(stat(state.pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    return
  }
  if (state.residue === undefined) throw new Error('test retained no changed index pin evidence')
  expect(state.cleanupFailed).toBe(true)
  const info = await localGitMutationNodeAdapter.lstat(state.pinPath)
  expect(info.isFile()).toBe(true)
  expect(info.isSymbolicLink()).toBe(false)
  expect({ device: info.dev.toString(), inode: info.ino.toString() }).toEqual(state.residue.identity)
  expect(info.size).toBe(BigInt(state.residue.bytes.byteLength))
  expect(await readFile(state.pinPath)).toEqual(state.residue.bytes)
}

function abortAfterOwnedIndexRead(
  root: string,
  controller: AbortController,
  reason: Error,
  target: 'pin' | 'lock',
  occurrence: number,
) {
  const indexPath = join(root, '.git', 'index')
  const state: {
    linkCalls: number
    renameCalls: number
    abortedAt?: { readonly kind: 'pin' | 'lock'; readonly count: number }
  } = {
    linkCalls: 0,
    renameCalls: 0,
  }
  const reads = { pin: 0, lock: 0 }
  const delegate = scratchRootTrackingNodeAdapter()
  const node: LocalGitMutationNodeAdapter = {
    ...delegate,
    async open(path, flags, mode) {
      const handle = await delegate.open(path, flags, mode)
      if (flags !== 'r') return handle
      const kind = path === `${indexPath}.lock`
        ? 'lock'
        : path.startsWith(`${indexPath}.saki-`) && path.endsWith('.pin') ? 'pin' : undefined
      if (kind === undefined) return handle
      return {
        ...handle,
        async close() {
          await handle.close()
          const count = ++reads[kind]
          if (kind === target && count === occurrence) {
            state.abortedAt = { kind, count }
            controller.abort(reason)
          }
        },
      }
    },
    async link(from: string, to: string) {
      state.linkCalls += 1
      await delegate.link(from, to)
    },
    async rename(from: string, to: string) {
      if (from === `${indexPath}.lock` && to === indexPath) state.renameCalls += 1
      await delegate.rename(from, to)
    },
  }
  return { node, state }
}

async function provider(
  root: string,
  options?: {
    readonly node?: LocalGitMutationNodeAdapter
    readonly config?: Partial<Config>
    readonly pushTransport?: LocalGitPushTransport
    readonly createTransportGitDirectory?: () => Promise<OwnedPrivateGitDirectory>
    readonly storageRoot?: string
  },
): Promise<LocalSakiHostExecution> {
  const ctx = new Context()
  contexts.push(ctx)
  const storageRoot = options?.storageRoot ?? await mkdtemp(join(tmpdir(), 'saki-host-operation-storage-'))
  if (options?.storageRoot === undefined) roots.push(storageRoot)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(storageRoot, 'saki.db'), journalMode: 'delete' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  provideInertLocalAgentRunDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('workspaceRegistry', { list: () => [{ id: WORKSPACE_ID, path: root }] })
  await ctx.plugin(LocalSakiHostExecution, { ...CONFIG, ...options?.config })
  const execution = ctx.sakiHostExecution as LocalSakiHostExecution
  if (options?.node !== undefined) installLocalGitMutationInternals(ctx, { node: options.node })
  if (options?.pushTransport !== undefined) {
    installLocalGitPushInternals(ctx, {
      transport: options.pushTransport,
      ...(options.createTransportGitDirectory === undefined
        ? {}
        : { createTransportGitDirectory: options.createTransportGitDirectory }),
    })
  }
  return execution
}

async function activeBinding(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
): Promise<ActiveHostProjectBinding> {
  const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
  expect(selected.ok, JSON.stringify(selected)).toBe(true)
  if (!selected.ok) throw new Error('test repository was not selectable')
  return {
    id: BINDING_ID,
    revision: 0,
    health: 'active',
    hostId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    expectedInspection: selected.inspection,
    inheritedChangeBaseline: selected.inspection.projection.baseline,
  }
}

async function prepareStageSelection(
  execution: LocalSakiHostExecution,
  binding: ActiveHostProjectBinding,
  inspected: Extract<Awaited<ReturnType<LocalSakiHostExecution['inspectProject']>>, { readonly ok: true }>,
  changes: StageFilesHostOperationRequest['changes'],
  signal: AbortSignal,
  payloadDigit: string,
) {
  if (inspected.preEffectBaseline.kind !== 'complete' || inspected.observation.index.kind !== 'tree') {
    throw new Error('test inspection was not mutable')
  }
  const request: StageFilesHostOperationRequest = {
    type: 'stage-files',
    source: {
      kind: 'control-intent',
      intentId: INTENT_ID,
      intentRevision: 2,
      payloadDigest: payloadDigit.repeat(64),
    },
    expected: {
      binding,
      status: inspected.observation.fingerprint,
      head: inspected.observation.head,
      index: inspected.observation.index,
      worktree: inspected.observation.worktree,
      preEffectBaseline: inspected.preEffectBaseline,
    },
    changes,
  }
  const prepared = await execution.prepareOperation(request, acceptedAdmission(9), signal)
  if (!prepared.ok) throw new Error(`test Stage was not prepared: ${prepared.reason}`)
  return prepared
}

async function preparedSymlinkStage(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
  payloadDigit: string,
) {
  const binding = await activeBinding(execution, root, signal)
  const worktreeRoot = binding.expectedInspection.trusted.canonicalWorktreePath
  const linkPath = join(worktreeRoot, 'link.txt')
  const targetBytes = Buffer.from('target-A', 'utf8')
  await symlink(targetBytes.toString('utf8'), linkPath, 'file')
  const inspected = await execution.inspectProject({ binding }, signal)
  if (!inspected.ok) throw new Error(`test symbolic link was not inspectable: ${inspected.reason}`)
  const change = inspected.observation.changes.find(candidate => candidate.path === 'link.txt')
  if (change === undefined) throw new Error('test inspection exposed no symbolic-link change')
  const prepared = await prepareStageSelection(
    execution,
    binding,
    inspected,
    [{ id: change.id, fingerprint: change.fingerprint }],
    signal,
    payloadDigit,
  )
  return {
    prepared,
    linkPath,
    targetBytes,
    indexPath: join(binding.expectedInspection.trusted.canonicalGitDirectory, 'index'),
  }
}

async function captureDurableNotStartedStage(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
  payloadDigit: string,
  admissionRevision: number,
) {
  const { prepared } = await preparedStage(
    execution, root, signal, payloadDigit, admissionRevision,
  )
  const persistence = operationPersistence(execution)
  let durable: LocalHostOperationRecord | undefined
  let registeredScratchPath: string | undefined
  persistence.replace(async (record) => {
    if (registeredScratchPath === undefined && record.effectPlan?.kind === 'index') {
      registeredScratchPath = record.effectPlan.scratch.path
      if (!roots.includes(registeredScratchPath)) roots.push(registeredScratchPath)
    }
    if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
      && record.effectPlan.publication === 'not-started') durable = record
    if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
      throw new Error('captured durable not-started Stage')
    }
    await persistence.original(record)
  })
  await expect(execution.startOperation(
    prepared.preparation.operation,
    prepared.acceptance,
    signal,
  )).rejects.toThrow('captured durable not-started Stage')
  persistence.restore()
  if (durable === undefined) throw new Error('test retained no durable not-started Stage')
  return { prepared, durable }
}

async function captureDurableNotStartedUnstage(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
  payloadDigit: string,
  admissionRevision: number,
) {
  const { prepared } = await preparedUnstage(
    execution, root, signal, payloadDigit, admissionRevision,
  )
  const persistence = operationPersistence(execution)
  let durable: LocalHostOperationRecord | undefined
  let registeredScratchPath: string | undefined
  persistence.replace(async (record) => {
    if (registeredScratchPath === undefined && record.effectPlan?.kind === 'index') {
      registeredScratchPath = record.effectPlan.scratch.path
      if (!roots.includes(registeredScratchPath)) roots.push(registeredScratchPath)
    }
    if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
      && record.effectPlan.operation === 'unstage-files'
      && record.effectPlan.publication === 'not-started') durable = record
    if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
      && record.effectPlan.operation === 'unstage-files'
      && record.effectPlan.publication === 'attempting') {
      throw new Error('captured durable not-started Unstage')
    }
    await persistence.original(record)
  })
  await expect(execution.startOperation(
    prepared.preparation.operation,
    prepared.acceptance,
    signal,
  )).rejects.toThrow('captured durable not-started Unstage')
  persistence.restore()
  if (durable === undefined) throw new Error('test retained no durable not-started Unstage')
  return { prepared, durable }
}

async function captureDurableNotStartedCommit(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
  payloadDigit: string,
  admissionRevision: number,
  contents: string,
  message: string,
) {
  const { prepared } = await preparedCommit(
    execution, root, signal, payloadDigit, admissionRevision, contents, message,
  )
  const persistence = operationPersistence(execution)
  let durable: LocalHostOperationRecord | undefined
  let registeredScratchPath: string | undefined
  persistence.replace(async (record) => {
    if (registeredScratchPath === undefined && record.effectPlan?.kind === 'commit') {
      registeredScratchPath = record.effectPlan.scratch.path
      if (!roots.includes(registeredScratchPath)) roots.push(registeredScratchPath)
    }
    if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
      && record.effectPlan.publication === 'not-started') durable = record
    if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
      && record.effectPlan.publication === 'attempting') {
      throw new Error('captured durable not-started Commit')
    }
    await persistence.original(record)
  })
  await expect(execution.startOperation(
    prepared.preparation.operation,
    prepared.acceptance,
    signal,
  )).rejects.toThrow('captured durable not-started Commit')
  persistence.restore()
  if (durable === undefined) throw new Error('test retained no durable not-started Commit')
  expect(sakiHostExecutionDomainSpec.tables.operations.valueSchema.safeParse(durable).success).toBe(true)
  return { prepared, durable }
}

async function captureAcknowledgedLostAttachedCommit(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
  payloadDigit: string,
  admissionRevision: number,
) {
  const { prepared } = await preparedCommit(
    execution,
    root,
    signal,
    payloadDigit,
    admissionRevision,
    `reflog recovery ${payloadDigit}\n`,
    `reflog recovery ${payloadDigit}\n`,
  )
  const persistence = operationPersistence(execution)
  let durable: LocalHostOperationRecord | undefined
  let registeredScratchPath: string | undefined
  persistence.replace(async (record) => {
    if (registeredScratchPath === undefined && record.effectPlan?.kind === 'commit') {
      registeredScratchPath = record.effectPlan.scratch.path
      if (!roots.includes(registeredScratchPath)) roots.push(registeredScratchPath)
    }
    if (record.snapshot.state === 'succeeded') {
      durable = record
      throw new Error('simulated Commit acknowledgement loss for reflog inspection')
    }
    await persistence.original(record)
  })
  await expect(execution.startOperation(
    prepared.preparation.operation,
    prepared.acceptance,
    signal,
  )).rejects.toThrow('simulated Commit acknowledgement loss for reflog inspection')
  persistence.restore()
  if (durable?.effectPlan?.kind !== 'commit') {
    throw new Error('test retained no acknowledged Commit plan')
  }
  const publishedCommit = await gitText(root, 'rev-parse', 'refs/heads/main')
  await git(root, 'commit', '--allow-empty', '-m', `later Commit ${payloadDigit}`)
  expect(await gitText(root, 'rev-parse', 'refs/heads/main')).not.toBe(publishedCommit)
  return {
    prepared,
    durable: { ...durable, effectPlan: durable.effectPlan },
    publishedCommit,
    reflogPath: join(root, '.git', 'logs', 'refs', 'heads', 'main'),
  }
}

type StageCancelIndexEvidenceFailureKind = 'abort' | 'retryable' | 'no-effect' | 'unexpected'

async function expectStageCancelIndexEvidenceFailure(
  kind: StageCancelIndexEvidenceFailureKind,
  payloadDigit: string,
  admissionRevision: number,
): Promise<void> {
  const root = await repository()
  const indexPath = join(root, '.git', 'index')
  const lockPath = `${indexPath}.lock`
  const controller = new AbortController()
  const abortReason = new Error('caller aborted during cancel index evidence')
  const lowerFailure = new Error('index evidence failed while caller aborted')
  const retryableFailure = Object.assign(new Error('injected cancel index evidence EIO'), {
    code: 'EIO',
    errno: -5,
    syscall: 'lstat',
    path: indexPath,
  })
  const unexpectedFailure = new Error('injected unexpected cancel index evidence failure')
  const holdingRoot = kind === 'no-effect'
    ? await mkdtemp(join(dirname(indexPath), '.saki-stage-cancel-index-'))
    : undefined
  const retainedIndexPath = holdingRoot === undefined ? undefined : join(holdingRoot, 'index')
  const state = {
    cancelActive: false,
    cancelEvidenceArmed: false,
    injected: false,
    recoveryReadCloses: 0,
    phaseLstats: 0,
    indexOpens: 0,
    cancelEvidenceOpens: 0,
    lockLinks: 0,
    indexPublications: 0,
    pinPath: undefined as string | undefined,
    postCloseStat: undefined as (() => Promise<unknown>) | undefined,
    directoryIdentity: undefined as { readonly device: string; readonly inode: string } | undefined,
  }
  const node: LocalGitMutationNodeAdapter = {
    ...localGitMutationNodeAdapter,
    async lstat(path) {
      const info = await localGitMutationNodeAdapter.lstat(path)
      if (!state.cancelActive || !state.cancelEvidenceArmed || state.injected
        || path !== indexPath) return info
      state.phaseLstats += 1
      state.injected = true
      switch (kind) {
        case 'abort':
          controller.abort(abortReason)
          throw lowerFailure
        case 'retryable':
          throw retryableFailure
        case 'unexpected':
          throw unexpectedFailure
        case 'no-effect': {
          if (retainedIndexPath === undefined) throw new Error('test retained no index holding path')
          await rename(path, retainedIndexPath)
          await mkdir(path, { mode: 0o700 })
          const directory = await localGitMutationNodeAdapter.lstat(path)
          state.directoryIdentity = {
            device: directory.dev.toString(),
            inode: directory.ino.toString(),
          }
          return directory
        }
      }
    },
    async open(path, flags, mode) {
      if (!state.cancelActive || path !== indexPath || flags !== 'r') {
        return await localGitMutationNodeAdapter.open(path, flags, mode)
      }
      state.indexOpens += 1
      if (state.cancelEvidenceArmed) state.cancelEvidenceOpens += 1
      const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
      if (state.cancelEvidenceArmed) return handle
      state.postCloseStat = async () => await handle.stat()
      return {
        ...handle,
        async close() {
          await handle.close()
          state.recoveryReadCloses += 1
          state.cancelEvidenceArmed = true
        },
      }
    },
    async link(from, to) {
      if (state.cancelActive && state.pinPath !== undefined && from === state.pinPath && to === lockPath) {
        state.lockLinks += 1
      }
      await localGitMutationNodeAdapter.link(from, to)
    },
    async rename(from, to) {
      if (state.cancelActive && from === lockPath && to === indexPath) state.indexPublications += 1
      await localGitMutationNodeAdapter.rename(from, to)
    },
  }
  const execution = await provider(root, { node })
  const { prepared, durable } = await captureDurableNotStartedStage(
    execution,
    root,
    controller.signal,
    payloadDigit,
    admissionRevision,
  )
  if (durable.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
  const plan = durable.effectPlan
  state.pinPath = plan.pin.path
  const trustedIndexPath = join(
    durable.request.expected.binding.expectedInspection.trusted.canonicalGitDirectory,
    'index',
  )
  expect(indexPath).toBe(trustedIndexPath)
  const quarantinePath = `${plan.scratch.path}.cleanup-${plan.scratch.markerDigest.slice(0, 32)}`
  const witnessPath = `${quarantinePath}.owner`
  for (const path of [plan.scratch.path, quarantinePath, witnessPath]) {
    if (!roots.includes(path)) roots.push(path)
  }
  const parent = await gitText(root, 'rev-parse', 'HEAD')
  expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
  expect(await gitText(root, 'diff', '--name-only')).toBe('tracked.txt')
  const originalIndex = await readFile(indexPath)
  const originalIndexInfo = await stat(indexPath, { bigint: true })
  const pinBytes = await readFile(plan.pin.path)
  const pinInfo = await stat(plan.pin.path, { bigint: true })
  const scratchInfo = await stat(plan.scratch.path, { bigint: true })
  const scratchOwner = await readFile(join(plan.scratch.path, 'owner'))
  const persistence = operationPersistence(execution)
  let persistCalls = 0
  persistence.replace(async (record) => {
    persistCalls += 1
    await persistence.original(record)
  })
  state.cancelActive = true
  try {
    if (kind === 'abort') {
      await expect(execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        controller.signal,
      )).rejects.toBe(abortReason)
    } else if (kind === 'unexpected') {
      await expect(execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        controller.signal,
      )).rejects.toBe(unexpectedFailure)
    } else {
      const retained = await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        controller.signal,
      )
      expect(retained).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
    }
  } finally {
    persistence.restore()
  }

  expect({
    injected: state.injected,
    recoveryReadCloses: state.recoveryReadCloses,
    phaseLstats: state.phaseLstats,
    indexOpens: state.indexOpens,
    cancelEvidenceOpens: state.cancelEvidenceOpens,
    lockLinks: state.lockLinks,
    indexPublications: state.indexPublications,
    persistCalls,
  }).toEqual({
    injected: true,
    recoveryReadCloses: 1,
    phaseLstats: 1,
    indexOpens: 1,
    cancelEvidenceOpens: 0,
    lockLinks: 0,
    indexPublications: 0,
    persistCalls: 0,
  })
  if (state.postCloseStat === undefined) throw new Error('test retained no recovery index handle')
  await expect(state.postCloseStat()).rejects.toThrow()

  if (kind === 'no-effect') {
    if (holdingRoot === undefined || retainedIndexPath === undefined
      || state.directoryIdentity === undefined) {
      throw new Error('test did not replace the cancel index with a directory')
    }
    const directory = await stat(indexPath, { bigint: true })
    expect(directory.isDirectory()).toBe(true)
    expect({ device: directory.dev.toString(), inode: directory.ino.toString() }).toEqual(
      state.directoryIdentity,
    )
    await expect(readFile(retainedIndexPath)).resolves.toEqual(originalIndex)
    const retainedInfo = await stat(retainedIndexPath, { bigint: true })
    expect({
      device: retainedInfo.dev.toString(),
      inode: retainedInfo.ino.toString(),
      mode: Number(retainedInfo.mode & 0o777n),
    }).toEqual({
      device: originalIndexInfo.dev.toString(),
      inode: originalIndexInfo.ino.toString(),
      mode: Number(originalIndexInfo.mode & 0o777n),
    })
    await localGitMutationNodeAdapter.rmdir(indexPath)
    await rename(retainedIndexPath, indexPath)
    await localGitMutationNodeAdapter.rmdir(holdingRoot)
    await expect(stat(holdingRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  }

  await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
  const finalIndexInfo = await stat(indexPath, { bigint: true })
  expect({
    device: finalIndexInfo.dev.toString(),
    inode: finalIndexInfo.ino.toString(),
    mode: Number(finalIndexInfo.mode & 0o777n),
  }).toEqual({
    device: originalIndexInfo.dev.toString(),
    inode: originalIndexInfo.ino.toString(),
    mode: Number(originalIndexInfo.mode & 0o777n),
  })
  expect(await execution.inspectOperation(
    prepared.preparation.operation,
    new AbortController().signal,
  )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
  expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
  expect(await gitText(root, 'diff', '--name-only')).toBe('tracked.txt')
  const finalPinInfo = await stat(plan.pin.path, { bigint: true })
  expect({
    device: finalPinInfo.dev.toString(),
    inode: finalPinInfo.ino.toString(),
    mode: Number(finalPinInfo.mode & 0o777n),
  }).toEqual({
    device: pinInfo.dev.toString(),
    inode: pinInfo.ino.toString(),
    mode: Number(pinInfo.mode & 0o777n),
  })
  await expect(readFile(plan.pin.path)).resolves.toEqual(pinBytes)
  expect(pinBytes.byteLength).toBe(plan.pin.byteLength)
  expect(createHash('sha256').update(pinBytes).digest('hex')).toBe(plan.pin.digest)
  const finalScratchInfo = await stat(plan.scratch.path, { bigint: true })
  expect({
    device: finalScratchInfo.dev.toString(),
    inode: finalScratchInfo.ino.toString(),
    mode: Number(finalScratchInfo.mode & 0o777n),
  }).toEqual({
    device: scratchInfo.dev.toString(),
    inode: scratchInfo.ino.toString(),
    mode: Number(scratchInfo.mode & 0o777n),
  })
  await expect(readFile(join(plan.scratch.path, 'owner'))).resolves.toEqual(scratchOwner)
  await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

  state.cancelActive = false
  expect(await execution.cancelOperation(
    prepared.preparation.operation,
    'source-canceled',
    new AbortController().signal,
  )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
  await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
  expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
  expect(await gitText(root, 'diff', '--name-only')).toBe('tracked.txt')
  await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
}

type CommitCancelTargetFailureKind = 'abort' | 'unexpected'

async function expectCommitCancelTargetFailure(
  kind: CommitCancelTargetFailureKind,
  payloadDigit: string,
  admissionRevision: number,
): Promise<void> {
  const root = await repository()
  const controller = new AbortController()
  const abortReason = new Error('caller aborted during second Commit cancel target read')
  const lowerFailure = new Error('Commit target read failed while caller aborted')
  const unexpectedFailure = new Error('injected unexpected second Commit cancel target failure')
  const execution = await provider(root)
  const { prepared, durable } = await captureDurableNotStartedCommit(
    execution,
    root,
    controller.signal,
    payloadDigit,
    admissionRevision,
    `second cancel target ${kind}\n`,
    `second cancel target ${kind}\n`,
  )
  if (durable.effectPlan?.kind !== 'commit') throw new Error('test retained no durable Commit plan')
  const plan = durable.effectPlan
  const indexPath = join(
    durable.request.expected.binding.expectedInspection.trusted.canonicalGitDirectory,
    'index',
  )
  const worktreePath = durable.request.expected.binding.expectedInspection.trusted.canonicalWorktreePath
  const lockPath = `${indexPath}.lock`
  const targetCommand = ['rev-parse', '--verify', '--end-of-options', plan.targetRef]
  const quarantinePath = `${plan.scratch.path}.cleanup-${plan.scratch.markerDigest.slice(0, 32)}`
  const witnessPath = `${quarantinePath}.owner`
  for (const path of [plan.scratch.path, quarantinePath, witnessPath]) {
    if (!roots.includes(path)) roots.push(path)
  }
  const parent = await gitText(root, 'rev-parse', 'HEAD')
  const stagedTree = await gitText(root, 'write-tree')
  expect(parent).toBe(plan.expectedOldObjectId)
  expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  expect(await gitText(root, 'diff', '--name-only')).toBe('')
  const originalIndex = await readFile(indexPath)
  const originalIndexInfo = await stat(indexPath, { bigint: true })
  const pinBytes = await readFile(plan.pin.path)
  const pinInfo = await stat(plan.pin.path, { bigint: true })
  const scratchInfo = await stat(plan.scratch.path, { bigint: true })
  const scratchOwner = await readFile(join(plan.scratch.path, 'owner'))
  const state = {
    firstReadCompleted: false,
    firstTargetObjectId: undefined as string | undefined,
    exactTargetReads: 0,
    secondTargetReads: 0,
    injected: false,
    persistCalls: 0,
    updateRefCalls: 0,
  }
  const persistence = operationPersistence(execution)
  persistence.replace(async (record) => {
    state.persistCalls += 1
    await persistence.original(record)
  })
  const runner = mutationRunner(execution)
  runner.replaceRun(async (...args) => {
    const [cwd, command] = args
    if (cwd !== worktreePath || command.length !== targetCommand.length
      || !command.every((value, index) => value === targetCommand[index])) {
      return await runner.originalRun(...args)
    }
    state.exactTargetReads += 1
    if (!state.firstReadCompleted) {
      const result = await runner.originalRun(...args)
      const stdout = result.stdout.toString('utf8')
      if (result.stderr.byteLength !== 0
        || stdout !== `${plan.expectedOldObjectId}\n`
          && stdout !== `${plan.expectedOldObjectId}\r\n`) {
        throw new Error('first Commit cancel target read returned an unexpected object')
      }
      state.firstTargetObjectId = plan.expectedOldObjectId
      state.firstReadCompleted = true
      return result
    }
    state.secondTargetReads += 1
    if (!state.injected) {
      state.injected = true
      if (kind === 'abort') {
        controller.abort(abortReason)
        throw lowerFailure
      }
      throw unexpectedFailure
    }
    return await runner.originalRun(...args)
  })
  runner.replace(async (...args) => {
    const [, command] = args
    if (command[0] === 'update-ref') state.updateRefCalls += 1
    return await runner.original(...args)
  })

  try {
    const canceled = execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      controller.signal,
    )
    if (kind === 'abort') await expect(canceled).rejects.toBe(abortReason)
    else await expect(canceled).rejects.toBe(unexpectedFailure)
  } finally {
    persistence.restore()
    runner.restore()
  }

  expect(state).toEqual({
    firstReadCompleted: true,
    firstTargetObjectId: plan.expectedOldObjectId,
    exactTargetReads: 2,
    secondTargetReads: 1,
    injected: true,
    persistCalls: 0,
    updateRefCalls: 0,
  })
  expect(await execution.inspectOperation(
    prepared.preparation.operation,
    new AbortController().signal,
  )).toMatchObject({ state: 'publishing', revision: durable.snapshot.revision })
  await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
  const finalIndexInfo = await stat(indexPath, { bigint: true })
  expect({
    device: finalIndexInfo.dev.toString(),
    inode: finalIndexInfo.ino.toString(),
    mode: Number(finalIndexInfo.mode & 0o777n),
  }).toEqual({
    device: originalIndexInfo.dev.toString(),
    inode: originalIndexInfo.ino.toString(),
    mode: Number(originalIndexInfo.mode & 0o777n),
  })
  expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  expect(await gitText(root, 'write-tree')).toBe(stagedTree)
  expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  expect(await gitText(root, 'diff', '--name-only')).toBe('')
  const finalPinInfo = await stat(plan.pin.path, { bigint: true })
  expect({
    device: finalPinInfo.dev.toString(),
    inode: finalPinInfo.ino.toString(),
    mode: Number(finalPinInfo.mode & 0o777n),
  }).toEqual({
    device: pinInfo.dev.toString(),
    inode: pinInfo.ino.toString(),
    mode: Number(pinInfo.mode & 0o777n),
  })
  await expect(readFile(plan.pin.path)).resolves.toEqual(pinBytes)
  expect(pinBytes.byteLength).toBe(plan.pin.byteLength)
  expect(createHash('sha256').update(pinBytes).digest('hex')).toBe(plan.pin.digest)
  const finalScratchInfo = await stat(plan.scratch.path, { bigint: true })
  expect({
    device: finalScratchInfo.dev.toString(),
    inode: finalScratchInfo.ino.toString(),
    mode: Number(finalScratchInfo.mode & 0o777n),
  }).toEqual({
    device: scratchInfo.dev.toString(),
    inode: scratchInfo.ino.toString(),
    mode: Number(scratchInfo.mode & 0o777n),
  })
  await expect(readFile(join(plan.scratch.path, 'owner'))).resolves.toEqual(scratchOwner)
  await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

  expect(await execution.cancelOperation(
    prepared.preparation.operation,
    'source-canceled',
    new AbortController().signal,
  )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
  await expect(readFile(indexPath)).resolves.toEqual(originalIndex)
  expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  expect(await gitText(root, 'diff', '--name-only')).toBe('')
  await expect(stat(plan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(plan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(witnessPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
}

async function preparedStage(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
  payloadDigit: string,
  admissionRevision: number,
  selectedPath = 'tracked.txt',
) {
  const binding = await activeBinding(execution, root, signal)
  await writeFile(join(root, selectedPath), 'changed\n')
  const inspected = await execution.inspectProject({ binding }, signal)
  if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
    || inspected.observation.index.kind !== 'tree') {
    throw new Error(`test repository was not mutable: ${JSON.stringify(inspected)}`)
  }
  const change = inspected.observation.changes.find(candidate => candidate.path === selectedPath)
  if (change === undefined) throw new Error('test repository had no changed path')
  const request: StageFilesHostOperationRequest = {
    type: 'stage-files',
    source: {
      kind: 'control-intent',
      intentId: INTENT_ID,
      intentRevision: 2,
      payloadDigest: payloadDigit.repeat(64),
    },
    expected: {
      binding,
      status: inspected.observation.fingerprint,
      head: inspected.observation.head,
      index: inspected.observation.index,
      worktree: inspected.observation.worktree,
      preEffectBaseline: inspected.preEffectBaseline,
    },
    changes: [{ id: change.id, fingerprint: change.fingerprint }],
  }
  const admission: HostOperationAdmissionSource = () => Promise.resolve({ kind: 'accepted', admissionRevision })
  const prepared = await execution.prepareOperation(request, admission, signal)
  if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)
  return { prepared, change, binding }
}

async function preparedMissingIndexStage(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
  payloadDigit: string,
) {
  const binding = await activeBinding(execution, root, signal)
  const indexPath = join(binding.expectedInspection.trusted.canonicalGitDirectory, 'index')
  await expect(stat(indexPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(join(root, 'tracked.txt'), 'changed with no shared index\n')
  const inspected = await execution.inspectProject({ binding }, signal)
  if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
    || inspected.observation.index.kind !== 'tree') {
    throw new Error(`test repository with missing index was not mutable: ${JSON.stringify(inspected)}`)
  }
  const change = inspected.observation.changes.find(candidate => candidate.path === 'tracked.txt')
  if (change === undefined) throw new Error('test repository with missing index had no changed path')
  const prepared = await prepareStageSelection(
    execution,
    binding,
    inspected,
    [{ id: change.id, fingerprint: change.fingerprint }],
    signal,
    payloadDigit,
  )
  return { prepared, binding }
}

async function preparedUnstage(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
  payloadDigit: string,
  admissionRevision: number,
) {
  const binding = await activeBinding(execution, root, signal)
  await writeFile(join(root, 'tracked.txt'), 'staged change\n')
  await git(root, 'add', '--', 'tracked.txt')
  const inspected = await execution.inspectProject({ binding }, signal)
  if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
    || inspected.observation.index.kind !== 'tree') {
    throw new Error(`test repository was not mutable: ${JSON.stringify(inspected)}`)
  }
  const change = inspected.observation.changes.find(candidate => candidate.path === 'tracked.txt')
  if (change === undefined) throw new Error('test repository had no staged path')
  const request: UnstageFilesHostOperationRequest = {
    type: 'unstage-files',
    source: {
      kind: 'control-intent',
      intentId: INTENT_ID,
      intentRevision: 2,
      payloadDigest: payloadDigit.repeat(64),
    },
    expected: {
      binding,
      status: inspected.observation.fingerprint,
      head: inspected.observation.head,
      index: inspected.observation.index,
      worktree: inspected.observation.worktree,
      preEffectBaseline: inspected.preEffectBaseline,
    },
    changes: [{ id: change.id, fingerprint: change.fingerprint }],
  }
  const prepared = await execution.prepareOperation(request, acceptedAdmission(admissionRevision), signal)
  if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)
  return { prepared, change, binding }
}

function acceptedAdmission(admissionRevision: number): HostOperationAdmissionSource {
  return () => Promise.resolve({ kind: 'accepted', admissionRevision })
}

async function preparedCommit(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
  payloadDigit: string,
  admissionRevision: number,
  contents: string,
  message: string,
) {
  const binding = await activeBinding(execution, root, signal)
  await writeFile(join(root, 'tracked.txt'), contents)
  await git(root, 'add', '--', 'tracked.txt')
  const inspected = await execution.inspectProject({ binding }, signal)
  if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
    || inspected.observation.index.kind !== 'tree') {
    throw new Error(`test repository was not committable: ${JSON.stringify(inspected)}`)
  }
  const request: CommitHostOperationRequest = {
    type: 'commit',
    source: {
      kind: 'control-intent',
      intentId: INTENT_ID,
      intentRevision: 2,
      payloadDigest: payloadDigit.repeat(64),
    },
    expected: {
      binding,
      status: inspected.observation.fingerprint,
      head: inspected.observation.head,
      index: inspected.observation.index,
      worktree: inspected.observation.worktree,
      preEffectBaseline: inspected.preEffectBaseline,
    },
    message,
  }
  const admission: HostOperationAdmissionSource = () => Promise.resolve({ kind: 'accepted', admissionRevision })
  const prepared = await execution.prepareOperation(request, admission, signal)
  if (!prepared.ok) throw new Error(`test Commit was not prepared: ${prepared.reason}`)
  return { prepared, inspected, request }
}

function operationPersistence(execution: LocalSakiHostExecution) {
  const target = execution as unknown as {
    persistOperation: (record: LocalHostOperationRecord) => Promise<void>
  }
  const original = target.persistOperation.bind(execution)
  return {
    original,
    replace(replacement: (record: LocalHostOperationRecord) => Promise<void>) {
      target.persistOperation = replacement
    },
    restore() {
      target.persistOperation = original
    },
  }
}

function liveOperationCount(execution: LocalSakiHostExecution): number {
  return (execution as unknown as { liveOperations: ReadonlyMap<unknown, unknown> }).liveOperations.size
}

interface UnpublishedGitMutationWorld {
  readonly root: string
  readonly indexPath: string
  readonly lockPath: string
  readonly indexBytes: Buffer
  readonly indexIdentity: {
    readonly device: string
    readonly inode: string
    readonly mode: string
  }
  readonly parent: string
  readonly cachedDiff: string
  readonly worktreeDiff: string
}

interface FrozenGitMutationWorld extends UnpublishedGitMutationWorld {
  readonly pinPath: string
}

async function captureUnpublishedGitMutationWorld(
  root: string,
  indexPath: string,
  lockPath: string,
): Promise<UnpublishedGitMutationWorld> {
  const indexBytes = await readFile(indexPath)
  const index = await stat(indexPath, { bigint: true })
  return {
    root,
    indexPath,
    lockPath,
    indexBytes,
    indexIdentity: {
      device: index.dev.toString(),
      inode: index.ino.toString(),
      mode: index.mode.toString(),
    },
    parent: await gitText(root, 'rev-parse', 'HEAD'),
    cachedDiff: await gitText(root, 'diff', '--cached', '--name-only'),
    worktreeDiff: await gitText(root, 'diff', '--name-only'),
  }
}

async function expectUnpublishedGitMutationWorld(world: UnpublishedGitMutationWorld): Promise<void> {
  await expect(stat(world.lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(world.indexPath)).resolves.toEqual(world.indexBytes)
  const index = await stat(world.indexPath, { bigint: true })
  expect({
    device: index.dev.toString(),
    inode: index.ino.toString(),
    mode: index.mode.toString(),
  }).toEqual(world.indexIdentity)
  expect(await gitText(world.root, 'rev-parse', 'HEAD')).toBe(world.parent)
  expect(await gitText(world.root, 'diff', '--cached', '--name-only')).toBe(world.cachedDiff)
  expect(await gitText(world.root, 'diff', '--name-only')).toBe(world.worktreeDiff)
}

async function expectFrozenGitMutationWorld(world: FrozenGitMutationWorld): Promise<void> {
  await expect(stat(world.pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expectUnpublishedGitMutationWorld(world)
}

function mutationRunner(execution: LocalSakiHostExecution) {
  const target = execution as unknown as { git: GitRunner }
  const original = target.git.runMutation.bind(target.git)
  const originalRun = target.git.run.bind(target.git)
  return {
    original,
    originalRun,
    replace(replacement: GitRunner['runMutation']) {
      target.git.runMutation = replacement.bind(target.git)
    },
    replaceRun(replacement: GitRunner['run']) {
      target.git.run = replacement.bind(target.git)
    },
    restore() {
      target.git.runMutation = original
      target.git.run = originalRun
    },
  }
}

function differentHex(value: string): string {
  return `${value.startsWith('0') ? '1' : '0'}${value.slice(1)}`
}

type GitSentinelHook =
  | 'commit-msg'
  | 'post-commit'
  | 'post-index-change'
  | 'pre-commit'
  | 'prepare-commit-msg'
  | 'reference-transaction'

async function gitProgramSentinel(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const marker = join(root, 'executed')
  const script = join(root, 'sentinel.mjs')
  await writeFile(script, [
    "import { appendFileSync } from 'node:fs'",
    'appendFileSync(process.argv[2], `${process.argv[3]}\\n`)',
    '',
  ].join('\n'))
  const command = (label: string): string => [process.execPath, script, marker, label]
    .map(value => `'${value.replaceAll("'", "'\"'\"'")}'`)
    .join(' ')
  return {
    root,
    marker,
    command,
    async installHooks(...names: readonly GitSentinelHook[]) {
      for (const name of names) {
        const hook = join(root, name)
        await writeFile(hook, `#!/bin/sh\nexec ${command(name)}\n`)
        await chmod(hook, 0o755)
      }
    },
  }
}

async function gitTextWithInput(cwd: string, args: readonly string[], input: Uint8Array): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`Git control failed: ${error.message}; stderr=${JSON.stringify(stderr)}`))
        return
      }
      resolve(stdout.trim())
    })
    if (child.stdin === null) {
      child.kill()
      reject(new Error('Git control exposed no stdin'))
      return
    }
    child.stdin.end(Buffer.from(input))
  })
}

interface SameContentReplacementState {
  replaced: boolean
  foreignPath?: string | undefined
  retainedOriginalPath?: string | undefined
  foreignIdentity?: { readonly device: string; readonly inode: string } | undefined
}

interface OwnedLockForeignReplacement {
  readonly bytes: Buffer
  readonly identity: { readonly device: string; readonly inode: string }
}

async function replaceOwnedLockWithForeignSameBytes(path: string): Promise<OwnedLockForeignReplacement> {
  const bytes = await readFile(path)
  const info = await stat(path, { bigint: true })
  await unlink(path)
  await writeFile(path, bytes, {
    flag: 'wx',
    mode: Number(info.mode & 0o777n),
  })
  const foreign = await stat(path, { bigint: true })
  return {
    bytes,
    identity: { device: foreign.dev.toString(), inode: foreign.ino.toString() },
  }
}

function isTestOperationScratchWrapper(path: string): boolean {
  return dirname(path) === tmpdir()
    && basename(path).startsWith('saki-host-operation-')
    && !basename(path).includes('.cleanup-')
}

async function unlinkTestSymbolicLink(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) await unlink(path)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}

function scratchRootTrackingNodeAdapter(): LocalGitMutationNodeAdapter {
  return {
    ...localGitMutationNodeAdapter,
    async open(path, flags, mode) {
      const scratchPath = flags === 'wx' && basename(path) === 'owner'
        && isTestOperationScratchWrapper(dirname(path))
        ? dirname(path)
        : undefined
      if (scratchPath !== undefined && !roots.includes(scratchPath)) roots.push(scratchPath)
      const handle = await localGitMutationNodeAdapter.open(path, flags, mode)
      if (scratchPath === undefined) return handle
      return {
        ...handle,
        async close() {
          await handle.close()
          const owner = await readFile(path)
          const markerDigest = createHash('sha256').update(owner).digest('hex')
          const quarantinePath = `${scratchPath}.cleanup-${markerDigest.slice(0, 32)}`
          const witnessPath = `${quarantinePath}.owner`
          for (const cleanupPath of [quarantinePath, witnessPath]) {
            if (!roots.includes(cleanupPath)) roots.push(cleanupPath)
          }
        },
      }
    },
  }
}

type IndexPublicationBoundaryKind =
  | 'parent-device-drift'
  | 'pin-replaced-after-link'
  | 'link-source-missing'

interface IndexPublicationBoundaryState {
  active: boolean
  injected: boolean
  pinReadClosed: boolean
  linkAttempts: number
  successfulLinks: number
  lockRemovals: number
  publicationRenames: number
  pinPath?: string | undefined
  retainedOriginalPath?: string | undefined
  linkError?: unknown
  readonly foreign: SameContentReplacementState
}

function indexPublicationBoundaryNodeAdapter(
  indexPath: string,
  kind: IndexPublicationBoundaryKind,
): {
  readonly node: LocalGitMutationNodeAdapter
  readonly state: IndexPublicationBoundaryState
} {
  const lockPath = `${indexPath}.lock`
  const tracked = scratchRootTrackingNodeAdapter()
  const state: IndexPublicationBoundaryState = {
    active: false,
    injected: false,
    pinReadClosed: false,
    linkAttempts: 0,
    successfulLinks: 0,
    lockRemovals: 0,
    publicationRenames: 0,
    foreign: { replaced: false },
  }
  return {
    state,
    node: {
      ...tracked,
      async lstat(path) {
        const actual = await tracked.lstat(path)
        if (kind !== 'parent-device-drift' || !state.active || state.injected
          || !state.pinReadClosed || state.pinPath === undefined
          || path !== dirname(state.pinPath)) return actual
        Object.defineProperty(actual, 'dev', {
          value: actual.dev + 1n,
          enumerable: true,
          configurable: true,
        })
        state.injected = true
        return actual
      },
      async open(path, flags, mode) {
        const handle = await tracked.open(path, flags, mode)
        if (kind !== 'parent-device-drift' || !state.active
          || state.pinPath === undefined || path !== state.pinPath || flags !== 'r') return handle
        return {
          ...handle,
          async close() {
            await handle.close()
            state.pinReadClosed = true
          },
        }
      },
      async link(from, to) {
        if (!state.active || state.pinPath === undefined || from !== state.pinPath || to !== lockPath) {
          await tracked.link(from, to)
          return
        }
        state.linkAttempts += 1
        if (kind === 'link-source-missing') {
          state.retainedOriginalPath = `${from}.retained-link-source`
          await tracked.rename(from, state.retainedOriginalPath)
          await tracked.syncDirectory(dirname(from))
          state.injected = true
          try {
            await tracked.link(from, to)
          } catch (error) {
            state.linkError = error
            throw error
          }
          throw new Error('test link unexpectedly accepted a missing source')
        }
        await tracked.link(from, to)
        state.successfulLinks += 1
        if (kind === 'pin-replaced-after-link') {
          await replaceFileWithSameContents(state.foreign, from)
          await tracked.syncDirectory(dirname(from))
          state.injected = true
        }
      },
      async rm(path, options) {
        if (state.active && path === lockPath && options.recursive !== true) state.lockRemovals += 1
        await tracked.rm(path, options)
      },
      async rename(from, to) {
        if (state.active && from === lockPath && to === indexPath) state.publicationRenames += 1
        await tracked.rename(from, to)
      },
    },
  }
}

interface MutationEffectTrackingState {
  active: boolean
  ownerOpenAttempts: number
  ownerCloses: number
  pinOpenAttempts: number
  links: number
  renames: number
}

function mutationEffectTrackingNodeAdapter(): {
  readonly node: LocalGitMutationNodeAdapter
  readonly state: MutationEffectTrackingState
} {
  const state: MutationEffectTrackingState = {
    active: true,
    ownerOpenAttempts: 0,
    ownerCloses: 0,
    pinOpenAttempts: 0,
    links: 0,
    renames: 0,
  }
  const tracked = scratchRootTrackingNodeAdapter()
  return {
    state,
    node: {
      ...tracked,
      async open(path, flags, mode) {
        const owner = flags === 'wx' && basename(path) === 'owner'
          && isTestOperationScratchWrapper(dirname(path))
        const pin = flags === 'wx' && path.endsWith('.pin')
        if (state.active && owner) state.ownerOpenAttempts += 1
        if (state.active && pin) state.pinOpenAttempts += 1
        const handle = await tracked.open(path, flags, mode)
        if (!state.active || !owner) return handle
        return {
          ...handle,
          async close() {
            await handle.close()
            state.ownerCloses += 1
          },
        }
      },
      async link(from, to) {
        if (state.active) state.links += 1
        await tracked.link(from, to)
      },
      async rename(from, to) {
        if (state.active) state.renames += 1
        await tracked.rename(from, to)
      },
    },
  }
}

async function replaceFileWithSameContents(
  state: SameContentReplacementState,
  path: string,
): Promise<void> {
  const bytes = await readFile(path)
  const info = await stat(path, { bigint: true })
  const retainedOriginalPath = `${path}.retained-original`
  await rename(path, retainedOriginalPath)
  await writeFile(path, bytes, {
    flag: 'wx',
    mode: Number(info.mode & 0o777n),
  })
  const foreign = await stat(path, { bigint: true })
  state.replaced = true
  state.foreignPath = path
  state.retainedOriginalPath = retainedOriginalPath
  state.foreignIdentity = { device: foreign.dev.toString(), inode: foreign.ino.toString() }
}

function expectOperationRecordIssue(record: unknown, message: string): void {
  const parsed = sakiHostExecutionDomainSpec.tables.operations.valueSchema.safeParse(record)
  expect(parsed.success).toBe(false)
  if (parsed.success) return
  expect(parsed.error.issues.map(issue => issue.message)).toContain(message)
}

function operationRecordIssueDetails(record: unknown): string {
  const parsed = sakiHostExecutionDomainSpec.tables.operations.valueSchema.safeParse(record)
  expect(parsed.success).toBe(false)
  return parsed.success ? '' : JSON.stringify(parsed.error.issues)
}

function zeroBytesBase64(byteLength: number): string {
  const completeGroups = Math.floor(byteLength / 3)
  const tail = byteLength % 3 === 0 ? '' : byteLength % 3 === 1 ? 'AA==' : 'AAA='
  return `${'AAAA'.repeat(completeGroups)}${tail}`
}

interface TestPushTransport extends LocalGitPushTransport {
  readonly pushCount: number
  readonly readCount: number
}

function localPushTransport(
  remote: string,
  controls?: {
    readonly failReads?: ReadonlySet<number>
    readonly beforeRead?: (count: number, request: Parameters<LocalGitPushTransport['readBranch']>[0]) => Promise<void>
    readonly failPush?: boolean
    readonly afterPush?: () => Promise<void>
  },
): TestPushTransport {
  let pushCount = 0
  let readCount = 0
  return {
    get pushCount() { return pushCount },
    get readCount() { return readCount },
    async readBranch(request) {
      readCount += 1
      await controls?.beforeRead?.(readCount, request)
      if (controls?.failReads?.has(readCount) === true) throw new Error('simulated remote read failure')
      try {
        return { kind: 'commit', objectId: await gitText(remote, 'rev-parse', '--verify', request.targetRef) }
      } catch {
        return { kind: 'absent' }
      }
    },
    async pushBranch(request) {
      pushCount += 1
      if (controls?.failPush === true) throw new Error('simulated Push failure')
      const repositoryUrl = `https://github.com/${request.repository.nameWithOwner}.git`
      await run('git', [
        `--git-dir=${request.privateGitDirectory.path}`,
        ...gitHubPushArguments(request).map(arg => arg === repositoryUrl ? remote : arg),
      ], { windowsHide: true })
      await controls?.afterPush?.()
    },
  }
}

function pushRequest(
  binding: ActiveHostProjectBinding,
  commitId: string,
  payloadDigit: string,
  intentLastDigit = '1',
): PushBranchHostOperationRequest {
  return {
    type: 'push-branch',
    source: {
      kind: 'control-intent',
      intentId: `intent-11111111-1111-4111-8111-11111111111${intentLastDigit}` as SakiControlIntentId,
      intentRevision: 2,
      payloadDigest: payloadDigit.repeat(64),
    },
    expected: { binding, commitId, repository: { nameWithOwner: 'BreakfastDaPaiDang/saki' } },
    targetRef: 'refs/heads/main',
  }
}

function isPushOperationRecord(record: LocalHostOperationRecord): record is LocalHostPushBranchOperationRecord {
  return record.request.type === 'push-branch'
}

async function repository(objectFormat: 'sha1' | 'sha256' = 'sha1'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-host-operation-repository-'))
  roots.push(root)
  await git(root, 'init', '-b', 'main', `--object-format=${objectFormat}`)
  await git(root, 'config', 'user.name', 'Saki Test')
  await git(root, 'config', 'user.email', 'saki@example.invalid')
  await writeFile(join(root, 'tracked.txt'), 'base\n')
  await git(root, 'add', '--', 'tracked.txt')
  await git(root, 'commit', '-m', 'base')
  return root
}

async function unbornRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-host-operation-unborn-'))
  roots.push(root)
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Saki Test')
  await git(root, 'config', 'user.email', 'saki@example.invalid')
  return root
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', args, { cwd, windowsHide: true })
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
  return stdout.trim()
}
