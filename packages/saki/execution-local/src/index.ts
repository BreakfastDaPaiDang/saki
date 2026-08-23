/** Local Host provider for Saki project-selection inspection. @module @breakfastdapaidang/saki-execution-local */

import { constants as bufferConstants } from 'node:buffer'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  MAX_INHERITED_BASELINE_ENTRIES,
  MAX_INVENTORY_ENTRIES,
  SakiHostExecution,
} from '@breakfastdapaidang/saki-execution'
import type { InspectProjectSelectionRequest, InspectProjectSelectionResult } from '@breakfastdapaidang/saki-execution'
import type {} from '@deepseek-ai/dsh-workspace'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { gitInspectionEnvironment, GitRunner, runBoundedCommand } from './git-runner.ts'
import { inspectLocalProjectSelection } from './inspection.ts'
import { readLocalAdministrativeDirectoryIdentity } from './identity.ts'

/** Local Git observation and baseline resource limits. */
export interface Config {
  /** Wall-clock bound for each Git process. */
  gitCommandTimeoutMs?: number
  /** TERM-to-KILL grace for each Git process tree. */
  gitTerminationGraceMs?: number
  /** Inclusive complete stdout bound for each Git process. */
  maxGitStdoutBytes?: number
  /** Inclusive complete stderr bound for each Git process. */
  maxGitStderrBytes?: number
  /** Maximum distinct paths in one complete repository inventory. */
  inventoryMaxEntries?: number
  /** Maximum exact path bytes across one complete repository inventory. */
  inventoryMaxPathBytes?: number
  /** Maximum raw Git stdout plus stderr bytes across one repository observation round. */
  inventoryMaxGitOutputBytes?: number
  /** Maximum retained raw evidence bytes from one inventory path. */
  inventoryMaxFileBytes?: number
  /** Maximum raw bytes read, including stability checks, across one repository inventory. */
  inventoryMaxTotalFileBytes?: number
  /** Wall-clock bound for one complete Git, filesystem, and Workspace observation round. */
  inventoryMaxCaptureMs?: number
  /** Maximum dirty entries in a complete inherited baseline. */
  baselineMaxEntries?: number
  /** Maximum sum of exact Git path bytes in a complete baseline. */
  baselineMaxPathBytes?: number
  /** Maximum allowlisted Git evidence bytes retained by one baseline. */
  baselineMaxGitOutputBytes?: number
  /** Maximum retained raw evidence bytes from one changed path. */
  baselineMaxFileBytes?: number
  /** Maximum bytes hashed across one complete baseline. */
  baselineMaxTotalFileBytes?: number
  /** Wall-clock bound for content baseline capture. */
  baselineMaxCaptureMs?: number
}

type ResolvedConfig = Required<Config>

const MINIMUM_GIT_VERSION = [2, 45, 0] as const
const GIT_VERSION_DECODER = new TextDecoder('utf-8', { fatal: true })

/** Local Host Execution provider with disposal-bound inspection lifetimes. */
export class LocalSakiHostExecution extends SakiHostExecution {
  static inject = ['fs', 'subprocess', 'workspaceRegistry']
  static Config: z<Config> = z.object({
    gitCommandTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
    gitTerminationGraceMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(250),
    maxGitStdoutBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(4 * 1024 * 1024),
    maxGitStderrBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(64 * 1024),
    inventoryMaxEntries: z.natural().min(1).max(MAX_INVENTORY_ENTRIES).default(MAX_INVENTORY_ENTRIES),
    inventoryMaxPathBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(16 * 1024 * 1024),
    inventoryMaxGitOutputBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(16 * 1024 * 1024),
    inventoryMaxFileBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(64 * 1024 * 1024),
    inventoryMaxTotalFileBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(512 * 1024 * 1024),
    inventoryMaxCaptureMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    baselineMaxEntries: z.natural().min(1).max(MAX_INHERITED_BASELINE_ENTRIES).default(MAX_INHERITED_BASELINE_ENTRIES),
    baselineMaxPathBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(4 * 1024 * 1024),
    baselineMaxGitOutputBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(16 * 1024 * 1024),
    baselineMaxFileBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(16 * 1024 * 1024),
    baselineMaxTotalFileBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(64 * 1024 * 1024),
    baselineMaxCaptureMs: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
  })

  private git!: GitRunner
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<InspectProjectSelectionResult>>()

  /** @param ctx - Local Host context. @param config - resolved Git observation limits. */
  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    super(ctx)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Saki Local Host Execution disposed'))
      while (this.active.size > 0) await Promise.allSettled([...this.active])
    }, 'saki-execution-local: abort and drain active inspections')
  }

  /** Resolve the system Git executable after required providers are active. */
  protected async [Service.init](): Promise<void> {
    const executable = await this.ctx.subprocess.resolveExecutable('git')
    const runnerConfig = {
      maxStdoutBytes: this.config.maxGitStdoutBytes,
      maxStderrBytes: this.config.maxGitStderrBytes,
      timeoutMs: this.config.gitCommandTimeoutMs,
      terminationGraceMs: this.config.gitTerminationGraceMs,
    }
    const { stdout, stderr } = await runBoundedCommand(this.ctx.subprocess, {
      argv: [executable, '--version'],
      cwd: process.cwd(),
      env: gitInspectionEnvironment(),
      ...runnerConfig,
    }, this.lifetime.signal)
    assertSupportedGitVersion(stdout, stderr)
    this.git = new GitRunner(this.ctx.subprocess, executable, runnerConfig)
  }

  override async inspectProjectSelection(
    request: InspectProjectSelectionRequest,
    signal: AbortSignal,
  ): Promise<InspectProjectSelectionResult> {
    if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
    const fused = AbortSignal.any([signal, this.lifetime.signal])
    const operation = inspectLocalProjectSelection(
      this.ctx.fs,
      this.ctx.workspaceRegistry,
      this.git,
      this.config,
      request,
      fused,
      readLocalAdministrativeDirectoryIdentity,
    )
    const tracked = operation.finally(() => this.active.delete(tracked))
    this.active.add(tracked)
    return await tracked
  }
}

/**
 * Reject Git versions that cannot provide the absolute, NUL-framed worktree
 * observations required by this provider.
 * @param bytes - complete bounded `git --version` stdout.
 * @param stderr - complete bounded `git --version` stderr.
 * @returns nothing after accepting Git 2.45 or newer.
 */
export function assertSupportedGitVersion(bytes: Uint8Array, stderr: Uint8Array): void {
  if (stderr.byteLength !== 0) throw new Error('Saki Local Host Execution requires Git 2.45 or newer')
  let text: string
  try {
    text = GIT_VERSION_DECODER.decode(bytes)
  } catch {
    throw new Error('Saki Local Host Execution requires Git 2.45 or newer')
  }
  const match = /^git version ([0-9]+)\.([0-9]+)(?:\.([0-9]+))?[^\r\n]*\r?\n$/u.exec(text)
  if (match === null) throw new Error('Saki Local Host Execution requires Git 2.45 or newer')
  const [, majorText, minorText, patchText] = match
  const [minimumMajor, minimumMinor, minimumPatch] = MINIMUM_GIT_VERSION
  const major = Number(majorText)
  const minor = Number(minorText)
  const patch = Number(patchText ?? 0)
  if (major > minimumMajor
    || (major === minimumMajor && minor > minimumMinor)
    || (major === minimumMajor && minor === minimumMinor && patch >= minimumPatch)) return
  throw new Error('Saki Local Host Execution requires Git 2.45 or newer')
}

export { GitCommandError } from './git-runner.ts'
export { sanitizeRemote } from './inspection.ts'

export default LocalSakiHostExecution
