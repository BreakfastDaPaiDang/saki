/** Bounded raw-byte Git command execution. @module @breakfastdapaidang/saki-execution-local/git-runner */

import type { Readable, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { GitCredentialHelperId } from '@breakfastdapaidang/saki-execution'

/** Publicly classifiable Git observation failure without child diagnostics. */
export class GitCommandError extends Error {
  /**
   * @param code - bounded failure category safe to retain or project.
   * @param exitCode - bounded child exit fact for a nonzero result.
   */
  constructor(readonly code: GitCommandErrorCode, readonly exitCode?: number | null) {
    super(`Saki Git inspection failed: ${code}`)
    this.name = 'GitCommandError'
  }
}

/** Closed failure categories emitted by the raw command runner. */
export type GitCommandErrorCode =
  | 'aborted'
  | 'timeout'
  | 'stdin-limit'
  | 'stdout-limit'
  | 'stderr-limit'
  | 'nonzero'
  | 'spawn-failure'
  | 'stream-failure'

/** Fully resolved command limits. */
export interface BoundedCommandSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdin?: { readonly bytes: Uint8Array; readonly maxBytes: number }
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly timeoutMs: number
  readonly terminationGraceMs: number
  readonly outputBudget?: RawOutputBudget
}

/** Shared streaming byte meter for an aggregate command sequence. */
export interface RawOutputBudget {
  /** @param bytes - next raw stdout or stderr chunk size. @returns whether the chunk remains within budget. */
  observe(bytes: number): boolean
}

/** Complete raw command output. */
export interface RawCommandOutput {
  readonly stdout: Buffer
  readonly stderr: Buffer
}

/** Configurable Local Host Git process limits. */
export interface GitRunnerConfig {
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly timeoutMs: number
  readonly terminationGraceMs: number
}

/** Closed Host-trusted helpers whose non-interactive behavior is configured by this provider. */
export type GitCredentialHelperAdapter = GitCredentialHelperId

/** Closed environment additions used only by structured Git mutation plumbing. */
export interface GitMutationEnvironment {
  readonly hooksDirectory: string
  readonly indexFile?: string
  readonly objectDirectory?: string
  readonly author?: {
    readonly name: string
    readonly email: string
    readonly date: string
  }
  readonly committer?: {
    readonly name: string
    readonly email: string
    readonly date: string
  }
}

/**
 * Construct the fixed repository-isolation prefix for one Host platform.
 * @param platform - platform whose null device Git must use.
 * @returns exact arguments prepended to every inspected Git command.
 */
export function gitGlobalArguments(platform: NodeJS.Platform): readonly string[] {
  const nullDevice = gitNullDevice(platform)
  return [
    '--no-pager',
    '--no-lazy-fetch',
    '--no-replace-objects',
    '-c', 'core.commitGraph=false',
    '-c', 'core.fsmonitor=false',
    '-c', 'advice.sparseIndexExpanded=false',
    '-c', 'core.pager=cat',
    '-c', 'credential.helper=',
    '-c', 'diff.external=',
    '-c', `core.hooksPath=${nullDevice}`,
    '-c', `core.excludesFile=${nullDevice}`,
    '-c', `core.attributesFile=${nullDevice}`,
    '--no-optional-locks',
  ]
}

const GIT_GLOBAL_ARGS = gitGlobalArguments(process.platform)

/**
 * Execute a process with raw pipe collection and join its complete process
 * tree before returning or throwing.
 * @param subprocess - execution-world process provider.
 * @param spec - exact argv, environment, and resource limits.
 * @param signal - required caller lifetime.
 * @returns complete stdout and stderr buffers.
 */
export async function runBoundedCommand(
  subprocess: SubprocessRuntime,
  spec: BoundedCommandSpec,
  signal: AbortSignal,
): Promise<RawCommandOutput> {
  if (signalAborted(signal)) throw new GitCommandError('aborted')
  if (spec.stdin !== undefined && spec.stdin.bytes.byteLength > spec.stdin.maxBytes) {
    throw new GitCommandError('stdin-limit')
  }
  const overflow = new AbortController()
  const internalFailure = new AbortController()
  using bound = deadline(
    AbortSignal.any([signal, overflow.signal, internalFailure.signal]),
    spec.timeoutMs,
    'SAKI_GIT_TIMEOUT',
  )
  let overflowCode: 'stdout-limit' | 'stderr-limit' | undefined
  let handle
  try {
    handle = subprocess.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      env: spec.env,
      stdio: { stdin: spec.stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.terminationGraceMs,
      signal: bound.signal,
    })
  } catch {
    throw new GitCommandError('spawn-failure')
  }
  const input = handle.stdin
  if (handle.stdout === undefined || handle.stderr === undefined
    || (spec.stdin !== undefined && input === undefined)) {
    terminateBestEffort(handle)
    await settleBestEffort(handle)
    throw new GitCommandError('spawn-failure')
  }

  const stdout = observeFailure(collectRaw(handle.stdout, spec.maxStdoutBytes, () => {
    overflowCode ??= 'stdout-limit'
    overflow.abort(new GitCommandError('stdout-limit'))
  }, spec.outputBudget))
  const stderr = observeFailure(collectRaw(handle.stderr, spec.maxStderrBytes, () => {
    overflowCode ??= 'stderr-limit'
    overflow.abort(new GitCommandError('stderr-limit'))
  }, spec.outputBudget))
  let stdin = Promise.resolve()
  if (spec.stdin !== undefined && input !== undefined) {
    stdin = observeFailure(writeRaw(input, spec.stdin.bytes))
  }
  const process = observeFailure(handle.done)
  const settled = await Promise.allSettled([stdout, stderr, process, stdin])
  if (settled.some(result => result.status === 'rejected') || bound.signal.aborted) terminateBestEffort(handle)
  let treeExited = false
  try {
    treeExited = await handle.waitForExit()
  } catch {
    // A provider wait failure has no safe diagnostic; teardown below owns recovery.
  }
  if (!treeExited) {
    terminateBestEffort(handle)
    await settleBestEffort(handle)
    throw new GitCommandError('spawn-failure')
  }

  if (overflowCode !== undefined) throw new GitCommandError(overflowCode)
  if (timeoutOf(bound.signal, 'SAKI_GIT_TIMEOUT') !== undefined) throw new GitCommandError('timeout')
  if (signalAborted(signal)) throw new GitCommandError('aborted')
  const stdoutResult = settled[0]
  const stderrResult = settled[1]
  const processResult = settled[2]
  const stdinResult = settled[3]
  if (processResult.status === 'rejected') throw new GitCommandError('spawn-failure')
  if (stdoutResult.status === 'rejected' || stderrResult.status === 'rejected'
    || stdinResult.status === 'rejected') {
    throw new GitCommandError('stream-failure')
  }
  if (processResult.value.exitCode !== 0) throw new GitCommandError('nonzero', processResult.value.exitCode)
  return { stdout: stdoutResult.value, stderr: stderrResult.value }

  function observeFailure<T>(promise: Promise<T>): Promise<T> {
    return promise.catch((error: unknown) => {
      if (!bound.signal.aborted) {
        internalFailure.abort(new Error('Saki Git process stream failed'))
      }
      throw error
    })
  }
}

function terminateBestEffort(handle: ReturnType<SubprocessRuntime['spawn']>): void {
  try {
    handle.terminate()
  } catch {
    // A provider termination failure is followed by a bounded settlement probe.
  }
}

async function settleBestEffort(handle: ReturnType<SubprocessRuntime['spawn']>): Promise<void> {
  await Promise.allSettled([
    handle.done,
    Promise.resolve().then(async () => await handle.waitForExit()),
  ])
}

/** Exact structured Git runner with one safety prefix and scrubbed environment. */
export class GitRunner {
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly executable: string,
    private readonly config: GitRunnerConfig,
  ) {}

  /**
   * Run one read-only Git subcommand.
   * @param cwd - explicit selected or canonical worktree directory.
   * @param args - exact Git subcommand arguments after the safety prefix.
   * @param signal - required caller lifetime.
   * @param stdin - optional exact input with its independently enforced byte bound.
   * @param outputBudget - optional aggregate streaming meter shared across commands.
   * @returns complete raw stdout and stderr buffers.
   */
  async run(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal,
    stdin?: { readonly bytes: Uint8Array; readonly maxBytes: number },
    outputBudget?: RawOutputBudget,
  ): Promise<RawCommandOutput> {
    return await runBoundedCommand(this.subprocess, {
      argv: [this.executable, ...GIT_GLOBAL_ARGS, ...args],
      cwd,
      env: gitInspectionEnvironment(),
      ...(stdin === undefined ? {} : { stdin }),
      ...(outputBudget === undefined ? {} : { outputBudget }),
      ...this.config,
    }, signal)
  }

  /**
   * Run fixed structured-mutation plumbing with only the explicitly modeled
   * index and identity environment additions.
   * @param cwd - canonical bound worktree.
   * @param args - fixed internal Git plumbing arguments.
   * @param signal - required attempt lifetime.
   * @param operation - private hooks directory and optional index/identity values.
   * @param stdin - optional exact byte input.
   * @returns complete bounded output.
   */
  async runMutation(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal,
    operation: GitMutationEnvironment,
    stdin?: { readonly bytes: Uint8Array; readonly maxBytes: number },
  ): Promise<RawCommandOutput> {
    const env = gitInspectionEnvironment()
    if (operation.indexFile !== undefined) env.GIT_INDEX_FILE = operation.indexFile
    if (operation.objectDirectory !== undefined) env.GIT_OBJECT_DIRECTORY = operation.objectDirectory
    if (operation.author !== undefined) {
      env.GIT_AUTHOR_NAME = operation.author.name
      env.GIT_AUTHOR_EMAIL = operation.author.email
      env.GIT_AUTHOR_DATE = operation.author.date
    }
    if (operation.committer !== undefined) {
      env.GIT_COMMITTER_NAME = operation.committer.name
      env.GIT_COMMITTER_EMAIL = operation.committer.email
      env.GIT_COMMITTER_DATE = operation.committer.date
    }
    return await runBoundedCommand(this.subprocess, {
      argv: [
        this.executable,
        ...GIT_GLOBAL_ARGS,
        '-c', `core.hooksPath=${operation.hooksDirectory}`,
        '-c', 'commit.gpgSign=false',
        '-c', 'i18n.commitEncoding=UTF-8',
        '-c', 'core.fsyncMethod=fsync',
        '-c', 'core.fsync=loose-object,index,reference',
        ...args,
      ],
      cwd,
      env,
      ...(stdin === undefined ? {} : { stdin }),
      ...this.config,
    }, signal)
  }

  /**
   * Run one fixed GitHub transport command from a private Git directory.
   * @param privateGitDirectory - repository-isolated Git control directory.
   * @param args - exact provider-owned transport arguments.
   * @param signal - required attempt lifetime.
   * @param adapter - closed Host-configured credential helper adapter.
   * @returns complete bounded transport output.
   */
  async runGitHubTransport(
    privateGitDirectory: string,
    args: readonly string[],
    signal: AbortSignal,
    adapter: GitCredentialHelperAdapter,
  ): Promise<RawCommandOutput> {
    const helper = adapter === 'git-credential-manager' ? 'manager' : 'manager-core'
    return await runBoundedCommand(this.subprocess, {
      argv: [
        this.executable,
        ...GIT_GLOBAL_ARGS,
        '-c', `credential.helper=${helper}`,
        '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always',
        '-c', 'http.followRedirects=false',
        `--git-dir=${privateGitDirectory}`,
        ...args,
      ],
      cwd: privateGitDirectory,
      env: {
        ...gitInspectionEnvironment(),
        GCM_INTERACTIVE: 'Never',
        GIT_CREDENTIAL_INTERACTIVE: 'never',
      },
      ...this.config,
    }, signal)
  }
}

/**
 * Remove all ambient Git control variables and apply the fixed non-interactive
 * locale/config layer used by every inspection command.
 * @param platform - platform whose null device Git must use.
 * @returns explicit environment overrides and tombstones.
 */
export function gitInspectionEnvironment(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const nullConfig = gitNullDevice(platform)
  let entries: [string, string | undefined][] = []
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) entries.push([key, undefined])
  }
  const overrides: NodeJS.ProcessEnv = {
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullConfig,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  }
  for (const [key, value] of Object.entries(overrides)) {
    const normalized = key.toUpperCase()
    entries = entries.filter(([existing]) => existing.toUpperCase() !== normalized)
    entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

function gitNullDevice(platform: NodeJS.Platform): 'NUL' | '/dev/null' {
  return platform === 'win32' ? 'NUL' : '/dev/null'
}

function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

async function writeRaw(stream: Writable, bytes: Uint8Array): Promise<void> {
  const settled = finished(stream)
  try {
    stream.end(Buffer.from(bytes))
  } catch {
    stream.destroy()
    await Promise.allSettled([settled])
    throw new Error('Git stdin stream failed')
  }
  await settled
}

async function collectRaw(
  stream: Readable,
  maxBytes: number,
  onOverflow: () => void,
  outputBudget?: RawOutputBudget,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let retainedBytes = 0
  let overflowed = false
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    if (overflowed) continue
    if (outputBudget !== undefined && !outputBudget.observe(chunk.byteLength)
      || chunk.byteLength > maxBytes - retainedBytes) {
      overflowed = true
      chunks.length = 0
      retainedBytes = 0
      onOverflow()
      continue
    }
    chunks.push(chunk)
    retainedBytes += chunk.byteLength
  }
  return Buffer.concat(chunks, retainedBytes)
}
