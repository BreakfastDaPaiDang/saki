/** Exact local Commit inspection for an active Host Resource Binding. @module @breakfastdapaidang/saki-execution-local/commit-inspection */

import { isDeepStrictEqual } from 'node:util'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type {
  ActiveHostProjectBinding,
  InspectProjectCommitResult,
} from '@breakfastdapaidang/saki-execution'
import {
  type AdministrativeDirectoryIdentityReader,
  type InspectionConfig,
  type WorkspaceIndex,
} from './inspection.ts'
import { GitCommandError, type GitRunner } from './git-runner.ts'
import { openSafeRepositoryView, type SafeRepositoryView } from './safe-repository.ts'

/** Dependencies that share the Local Host repository identity world. */
export interface LocalCommitInspectionDependencies {
  readonly fs: FileSystem
  readonly workspaces: WorkspaceIndex
  readonly git: GitRunner
  readonly config: InspectionConfig
  readonly identityReader: AdministrativeDirectoryIdentityReader
}

/**
 * Confirm that one exact object id still denotes a Commit in the bound repository.
 * @param dependencies - Local Host repository and identity capabilities.
 * @param binding - active Resource Binding revalidated at the read boundary.
 * @param commitId - exact object id; arbitrary revisions are not accepted.
 * @param signal - required observation lifetime.
 * @returns exact presence evidence or one bounded failure.
 */
export async function inspectLocalProjectCommit(
  dependencies: LocalCommitInspectionDependencies,
  binding: ActiveHostProjectBinding,
  commitId: string,
  signal: AbortSignal,
): Promise<InspectProjectCommitResult> {
  const opened = await openLocalProjectCommit(dependencies, binding, commitId, signal)
  if (!opened.ok) return opened.result
  await using _repository = opened.repository
  return { ok: true, commitId }
}

/**
 * Open one private repository view after revalidating an exact bound Commit.
 * @param dependencies - Local Host repository and identity capabilities.
 * @param binding - active Resource Binding revalidated at the read boundary.
 * @param commitId - exact Commit object id.
 * @param signal - required observation lifetime.
 * @returns an owned private view or one bounded failure.
 * @internal
 */
export async function openLocalProjectCommit(
  dependencies: LocalCommitInspectionDependencies,
  binding: ActiveHostProjectBinding,
  commitId: string,
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly repository: SafeRepositoryView }
  | { readonly ok: false; readonly result: Extract<InspectProjectCommitResult, { readonly ok: false }> }
> {
  const opened = await openSafeRepositoryView(
    dependencies.fs,
    dependencies.git,
    binding.expectedInspection.trusted.canonicalWorktreePath,
    dependencies.config.inventoryMaxFileBytes,
    signal,
  )
  if (opened.kind !== 'repository') {
    return { ok: false, result: { ok: false, reason: opened.kind === 'unavailable' || opened.kind === 'malformed'
      ? 'unavailable'
      : 'binding-stale' } }
  }
  const repository = opened.view
  try {
    if (!await boundRepositoryMatches(dependencies, binding, repository, signal)) {
      await repository[Symbol.asyncDispose]()
      return { ok: false, result: { ok: false, reason: 'binding-stale' } }
    }
    const output = await repository.git.run(
      repository.topLevelPath,
      ['rev-parse', '--verify', `${commitId}^{commit}`],
      signal,
    )
    const observed = decodeGitLine(output.stdout)
    /* v8 ignore start -- the fixed successful rev-parse emits one exact object-id line;
     * decodeGitLine unit tests own malformed process bytes while this remains fail closed. */
    if (output.stderr.byteLength !== 0 || observed !== commitId) {
      await repository[Symbol.asyncDispose]()
      return { ok: false, result: { ok: false, reason: 'unavailable' } }
    }
    /* v8 ignore stop */
    await repository.assertSourceControlUnchanged(signal)
    /* v8 ignore start -- this requires an external identity swap between consecutive
     * source-control and administrative-identity checks; the first check covers rejection. */
    if (!await boundRepositoryMatches(dependencies, binding, repository, signal)) {
      await repository[Symbol.asyncDispose]()
      return { ok: false, result: { ok: false, reason: 'binding-stale' } }
    }
    /* v8 ignore stop */
    return { ok: true, repository }
  } catch (error) {
    await repository[Symbol.asyncDispose]()
    /* v8 ignore next -- bounded Git cancellation is exercised at the shared runner and Host lifetime boundaries. */
    if (signal.aborted) throw signal.reason
    /* v8 ignore next -- exact missing Commit failures are exit 128; other runner and source races fail closed below. */
    if (error instanceof GitCommandError && error.code === 'nonzero' && error.exitCode === 128) {
      return { ok: false, result: { ok: false, reason: 'commit-missing' } }
    }
    /* v8 ignore next -- the remaining bounded runner and source-control failures share one unavailable result. */
    return { ok: false, result: { ok: false, reason: 'unavailable' } }
  }
}

async function boundRepositoryMatches(
  dependencies: LocalCommitInspectionDependencies,
  binding: ActiveHostProjectBinding,
  repository: SafeRepositoryView,
  signal: AbortSignal,
): Promise<boolean> {
  const expected = binding.expectedInspection.trusted
  const workspaces = dependencies.workspaces.list().filter(workspace => workspace.path === repository.topLevelPath)
  const gitIdentity = await dependencies.identityReader(repository.gitDirectoryPath, signal)
  const commonIdentity = await dependencies.identityReader(repository.commonDirectoryPath, signal)
  return isDeepStrictEqual({
    canonicalWorktreePath: repository.topLevelPath,
    canonicalGitDirectory: repository.gitDirectoryPath,
    canonicalCommonGitDirectory: repository.commonDirectoryPath,
    workspaceIds: workspaces.map(workspace => workspace.id),
    gitDirectoryIdentity: gitIdentity,
    commonGitDirectoryIdentity: commonIdentity,
  }, {
    canonicalWorktreePath: expected.canonicalWorktreePath,
    canonicalGitDirectory: expected.canonicalGitDirectory,
    canonicalCommonGitDirectory: expected.canonicalCommonGitDirectory,
    workspaceIds: [binding.workspaceId],
    gitDirectoryIdentity: expected.gitDirectoryIdentity,
    commonGitDirectoryIdentity: expected.commonGitDirectoryIdentity,
  })
}

/**
 * Decode one complete LF- or CRLF-terminated Git output line.
 * @param bytes - Bounded raw Git stdout.
 * @returns The line contents, or undefined for malformed UTF-8 or framing.
 * @internal
 */
export function decodeGitLine(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return /^(?<value>[^\r\n]*)\r?\n$/u.exec(text)?.groups?.value
  } catch {
    return undefined
  }
}
