/** Stable bounded file Diff reads for the Local Host provider. @module @breakfastdapaidang/saki-execution-local/diff */

import type { FileSystem } from '@deepseek-ai/dsh-fs'
import {
  MAX_PROJECT_GIT_DIFF_CURSOR_CHARS,
  MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES,
  MAX_PROJECT_GIT_DIFF_PAGE_LINES,
  MAX_PROJECT_GIT_DIFF_PAGE_UTF8_BYTES,
  MAX_PROJECT_GIT_DIFF_TOTAL_LINES,
  MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES,
} from '@breakfastdapaidang/saki-execution'
import type {
  ActiveHostProjectBinding,
  ProjectGitChange,
  ProjectGitChangeId,
  ProjectGitDiffCursor,
  ProjectGitDiffFailureReason,
  ProjectGitDiffLayer,
  ProjectGitDiffPage,
  ProjectGitStatusFingerprint,
  ProjectGitStatusObservation,
  ProjectSelectionInspection,
} from '@breakfastdapaidang/saki-execution'
import type { CapturedRepositoryInventory } from './baseline.ts'
import { exactBytesDigest } from './canonical.ts'
import {
  projectDiffQueryArguments,
  type ReadableProjectGitDiffLayer,
} from './diff-query.ts'
import { GitCommandError, type GitRunner, type RawOutputBudget } from './git-runner.ts'
import {
  BoundProjectResourceMismatchError,
  inspectStableLocalProjectSelection,
  type AdministrativeDirectoryIdentityReader,
  type InspectionConfig,
  type StableLocalProjectSelectionFailureReason,
  type WorkspaceIndex,
} from './inspection.ts'
import {
  openSafeRepositoryView,
  RepositoryControlChangedError,
  type SafeRepositoryOpenResult,
  type SafeRepositoryView,
} from './safe-repository.ts'
import { buildProjectGitStatusObservation, ProjectGitStatusProjectionError } from './status.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const PATCH_DIGEST_DOMAIN = 'saki/project-git-patch/v1'
const MAX_PORTABLE_GIT_ARGUMENT_BYTES = 64 * 1024
const WINDOWS_COMMAND_LINE_CHARS = 32_767
const WINDOWS_FIXED_COMMAND_RESERVE_CHARS = 4_096

/** Dependencies owned by one Local Host Execution provider instance. */
export interface LocalProjectDiffDependencies {
  readonly fs: FileSystem
  readonly workspaces: WorkspaceIndex
  readonly git: GitRunner
  readonly config: InspectionConfig
  readonly identityReader: AdministrativeDirectoryIdentityReader
  /** Trusted-composition overrides that preserve each replaced boundary's complete safety obligations. */
  readonly internals?: LocalProjectDiffInternals
}

/** Provider-neutral request fields after the trusted Binding is separated by the Host seam. */
export interface LocalProjectDiffRequest {
  readonly expectedStatus: ProjectGitStatusFingerprint
  readonly changeId: ProjectGitChangeId
  readonly layer: ProjectGitDiffLayer
  readonly cursor?: ProjectGitDiffCursor
}

/** Complete page or one closed safe failure produced by the Local Provider. */
export type LocalProjectDiffResult =
  | { readonly ok: true; readonly page: ProjectGitDiffPage }
  | { readonly ok: false; readonly reason: ProjectGitDiffFailureReason }

/** Complete internal evidence retained for one bound Diff observation. */
export interface BoundProjectObservation {
  readonly inspection: ProjectSelectionInspection
  readonly inventory: CapturedRepositoryInventory
  readonly status: ProjectGitStatusObservation
}

/** Closed internal result of one bound Diff observation. */
export type BoundProjectObservationResult =
  | { readonly ok: true; readonly value: BoundProjectObservation }
  | { readonly ok: false; readonly reason: ProjectGitDiffFailureReason }

/** Closed internal result of one stable complete patch read. */
export type PatchReadResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: ProjectGitDiffFailureReason }

/**
 * Trusted-provider overrides for Local Diff boundary implementations; omitted fields use secure defaults.
 * Every override must preserve the replaced function's validation, containment, and stability obligations.
 * @internal
 */
export interface LocalProjectDiffInternals {
  readonly inspectSelection?: typeof inspectStableLocalProjectSelection
  readonly buildStatus?: typeof buildProjectGitStatusObservation
  readonly openRepository?: typeof openSafeRepositoryView
}

/** Decoded identity and offset carried by one validated opaque Diff cursor. */
export interface DiffCursorMaterial {
  readonly version: 1
  readonly observationDigest: string
  readonly changeId: string
  readonly layer: ProjectGitDiffLayer
  readonly patchDigest: string
  readonly nextLine: number
}

/**
 * Read one file-scoped Diff page between two complete matching status observations.
 * @param dependencies - Local filesystem, Git, Workspace, and identity capabilities.
 * @param binding - trusted active Resource Binding revalidated on every observation.
 * @param request - status fingerprint, opaque change id, layer, and optional cursor.
 * @param signal - required caller lifetime and cancellation.
 * @returns one stable bounded page or a closed browser-safe failure.
 */
export async function readLocalProjectDiff(
  dependencies: LocalProjectDiffDependencies,
  binding: ActiveHostProjectBinding,
  request: LocalProjectDiffRequest,
  signal: AbortSignal,
): Promise<LocalProjectDiffResult> {
  signal.throwIfAborted()
  const cursor = request.cursor === undefined ? undefined : decodeCursor(request.cursor)
  if (cursor?.ok === false) return { ok: false, reason: 'invalid-cursor' }
  if (cursor !== undefined && (cursor.value.observationDigest !== request.expectedStatus.digest
    || cursor.value.changeId !== request.changeId
    || cursor.value.layer !== request.layer)) {
    return { ok: false, reason: 'cursor-stale' }
  }

  const initial = await observeBoundProject(dependencies, binding, signal)
  if (!initial.ok) return initial
  if (!sameStatusFingerprint(initial.value.status.fingerprint, request.expectedStatus)) {
    return { ok: false, reason: 'observation-stale' }
  }
  const target = resolveProjectDiffTarget(initial.value, request)
  if (!target.ok) return target

  const patch = await readStablePatch(
    dependencies,
    binding,
    initial.value,
    target.path,
    target.layer,
    signal,
  )
  const finalFailure = await revalidateExpectedObservation(
    dependencies,
    binding,
    request.expectedStatus,
    signal,
  )
  if (finalFailure !== undefined) return { ok: false, reason: finalFailure }
  if (!patch.ok) return patch

  return completeProjectDiffPage(request, cursor?.value, patch.bytes)
}

/**
 * Resolve one request to exactly one raw inventory path without performing repository I/O.
 * @param observed - complete status and inventory evidence from one stable observation.
 * @param request - requested observation, change identity, and layer.
 * @returns the exact raw path or one closed target-resolution failure.
 */
export function resolveProjectDiffTarget(
  observed: BoundProjectObservation,
  request: LocalProjectDiffRequest,
): { readonly ok: true; readonly path: Uint8Array; readonly layer: ReadableProjectGitDiffLayer }
  | { readonly ok: false; readonly reason: ProjectGitDiffFailureReason } {
  const [change, ...additionalChanges] = observed.status.changes
    .filter(candidate => candidate.id === request.changeId)
  if (change === undefined) return { ok: false, reason: 'change-missing' }
  if (additionalChanges.length !== 0) return { ok: false, reason: 'change-ambiguous' }
  if (request.layer === 'conflict' || change.kind === 'unmerged') {
    return { ok: false, reason: 'conflict' }
  }
  if (change.kind === 'untracked') return { ok: false, reason: 'untracked' }
  if (change.submodule.kind === 'submodule') return { ok: false, reason: 'unavailable' }
  const [inventoryEntry, ...additionalInventoryEntries] = resolveInventoryEntries(observed.inventory, change)
  if (inventoryEntry === undefined) return { ok: false, reason: 'change-missing' }
  if (additionalInventoryEntries.length !== 0) return { ok: false, reason: 'change-ambiguous' }
  if (request.layer === 'unstaged' && inventoryEntry.conversion.executableFilter) {
    return { ok: false, reason: 'unavailable' }
  }
  if (!changeHasLayer(change, request.layer)) return { ok: false, reason: 'layer-missing' }
  const rawPath = inventoryEntry.path
  if (!projectDiffCommandFits(rawPath, observed.inspection.trusted.canonicalWorktreePath)) {
    return { ok: false, reason: 'command-length' }
  }
  return { ok: true, path: rawPath, layer: request.layer }
}

/**
 * Validate complete stable patch bytes against the cursor's patch digest and offset, then build one bounded page.
 * @param request - observation, change identity, and requested layer.
 * @param cursor - decoded validated cursor, when continuing an earlier page.
 * @param bytes - complete stable patch bytes.
 * @returns one bounded page or a closed patch/cursor failure.
 */
export function completeProjectDiffPage(
  request: LocalProjectDiffRequest,
  cursor: DiffCursorMaterial | undefined,
  bytes: Buffer,
): LocalProjectDiffResult {
  const patchDigest = exactBytesDigest(PATCH_DIGEST_DOMAIN, bytes)
  if (cursor !== undefined && cursor.patchDigest !== patchDigest) {
    return { ok: false, reason: 'cursor-stale' }
  }
  const parsed = parseProjectDiffPatch(bytes)
  if (!parsed.ok) return parsed
  const startLine = cursor?.nextLine ?? 0
  if (startLine >= parsed.lines.length) return { ok: false, reason: 'invalid-cursor' }
  return {
    ok: true,
    page: buildPage(
      request,
      parsed.lines,
      bytes.byteLength,
      patchDigest,
      startLine,
    ),
  }
}

/**
 * Conservatively test whether provider-resolved path arguments fit portable process limits.
 * @param path - exact UTF-8 repository-relative path from the current observation.
 * @param worktreePath - canonical bound worktree path included in the private Git argv.
 * @param platform - Host platform whose process creation rules apply.
 * @returns whether the fixed command remains below the portable safety ceilings.
 */
export function projectDiffCommandFits(
  path: Uint8Array,
  worktreePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (path.byteLength > MAX_PORTABLE_GIT_ARGUMENT_BYTES) return false
  if (platform !== 'win32') return true
  let pathText: string
  try {
    pathText = UTF8.decode(path)
  } catch {
    return false
  }
  const worstCaseChars = WINDOWS_FIXED_COMMAND_RESERVE_CHARS
    + 2 * pathText.length
    + 2 * worktreePath.length
  return worstCaseChars < WINDOWS_COMMAND_LINE_CHARS
}

/**
 * Re-inspect one trusted Resource Binding and project its complete status evidence.
 * @param dependencies - Local filesystem, Git, Workspace, identity, and trusted boundary implementations.
 * @param binding - active Resource Binding whose exact repository identity must still match.
 * @param signal - required caller lifetime.
 * @returns complete bound evidence or a closed browser-safe failure.
 * @internal
 */
export async function observeBoundProject(
  dependencies: LocalProjectDiffDependencies,
  binding: ActiveHostProjectBinding,
  signal: AbortSignal,
): Promise<BoundProjectObservationResult> {
  let selected
  try {
    const inspectSelection = dependencies.internals?.inspectSelection ?? inspectStableLocalProjectSelection
    selected = await inspectSelection(
      dependencies.fs,
      dependencies.workspaces,
      dependencies.git,
      dependencies.config,
      {
        hostId: binding.hostId,
        directoryLocator: binding.expectedInspection.trusted.canonicalWorktreePath,
      },
      signal,
      dependencies.identityReader,
      {
        boundResource: {
          workspaceId: binding.workspaceId,
          trusted: binding.expectedInspection.trusted,
        },
      },
    )
  } catch (error) {
    if (error instanceof BoundProjectResourceMismatchError) {
      return { ok: false, reason: 'binding-stale' }
    }
    throw error
  }
  if (!selected.ok) return { ok: false, reason: projectDiffSelectionFailureReason(selected.reason) }
  try {
    return {
      ok: true,
      value: {
        inspection: selected.inspection,
        inventory: selected.inventory,
        status: (dependencies.internals?.buildStatus ?? buildProjectGitStatusObservation)(
          selected.inventory,
          selected.inspection,
          binding,
          signal,
          selected.status,
          selected.inspection.projection.baseline,
          selected.unsupportedIndexState,
        ),
      },
    }
  } catch (error) {
    if (error instanceof ProjectGitStatusProjectionError) {
      return {
        ok: false,
        reason: error.reason === 'invalid-path' ? 'malformed' : 'unavailable',
      }
    }
    throw error
  }
}

/**
 * Capture two equal file-scoped patch passes from one admitted private repository view.
 * @param dependencies - Local repository capabilities and trusted admission overrides.
 * @param binding - active Resource Binding revalidated between patch commands.
 * @param observed - complete initial observation that pins repository and status identity.
 * @param path - exact raw inventory path selected by the request.
 * @param layer - staged or unstaged comparison layer.
 * @param signal - required caller lifetime.
 * @returns complete stable patch bytes or a closed browser-safe failure.
 * @internal
 */
export async function readStablePatch(
  dependencies: LocalProjectDiffDependencies,
  binding: ActiveHostProjectBinding,
  observed: BoundProjectObservation,
  path: Uint8Array,
  layer: ReadableProjectGitDiffLayer,
  signal: AbortSignal,
): Promise<PatchReadResult> {
  const pathText = decodePath(path)
  if (pathText === undefined) return { ok: false, reason: 'malformed' }
  const openRepository = dependencies.internals?.openRepository ?? openSafeRepositoryView
  const opened = await openRepository(
    dependencies.fs,
    dependencies.git,
    observed.inspection.trusted.canonicalWorktreePath,
    dependencies.config.inventoryMaxFileBytes,
    signal,
  )
  if (opened.kind !== 'repository') {
    return { ok: false, reason: projectDiffRepositoryOpenFailureReason(opened.kind) }
  }
  await using repository = opened.view
  try {
    const admission = await boundViewAdmission(dependencies, binding, observed, repository, signal)
    if (admission !== undefined) return { ok: false, reason: admission }
    const firstPreflight = await runDiffQuery(
      repository,
      projectDiffQueryArguments('binary-preflight', pathText, layer, observed.status.head),
      signal,
      MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES,
    )
    const preflightCheckpointFailure = await checkpointExpectedPatchView(
      dependencies,
      binding,
      observed,
      repository,
      signal,
    )
    if (preflightCheckpointFailure !== undefined) {
      return { ok: false, reason: preflightCheckpointFailure }
    }
    const firstKind = parseProjectDiffBinaryPreflight(firstPreflight, path)
    if (firstKind === 'malformed') return { ok: false, reason: 'malformed' }
    const firstPatch = firstKind === 'text'
      ? await runDiffQuery(
        repository,
        projectDiffQueryArguments('patch', pathText, layer, observed.status.head),
        signal,
        MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES,
      )
      : undefined
    if (firstPatch !== undefined) {
      const checkpointFailure = await checkpointExpectedPatchView(
        dependencies,
        binding,
        observed,
        repository,
        signal,
      )
      if (checkpointFailure !== undefined) return { ok: false, reason: checkpointFailure }
    }
    const secondPreflight = await runDiffQuery(
      repository,
      projectDiffQueryArguments('binary-preflight', pathText, layer, observed.status.head),
      signal,
      MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES,
    )
    const secondKind = parseProjectDiffBinaryPreflight(secondPreflight, path)
    if (!firstPreflight.equals(secondPreflight) || firstKind !== secondKind) {
      return { ok: false, reason: 'ambiguous' }
    }
    if (secondKind === 'binary') {
      await repository.assertSourceControlUnchanged(signal)
      return { ok: false, reason: 'binary' }
    }
    if (secondKind === 'missing') {
      await repository.assertSourceControlUnchanged(signal)
      return { ok: false, reason: 'layer-missing' }
    }
    const stableFirstPatch = firstPatch as Buffer
    const secondPatch = await runDiffQuery(
      repository,
      projectDiffQueryArguments('patch', pathText, layer, observed.status.head),
      signal,
      MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES,
    )
    await repository.assertSourceControlUnchanged(signal)
    if (!stableFirstPatch.equals(secondPatch)) return { ok: false, reason: 'ambiguous' }
    if (stableFirstPatch.byteLength === 0) return { ok: false, reason: 'layer-missing' }
    return { ok: true, bytes: stableFirstPatch }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof RepositoryControlChangedError) return { ok: false, reason: 'ambiguous' }
    if (error instanceof GitCommandError) {
      if (error.code === 'timeout') return { ok: false, reason: 'time' }
      if (error.code === 'stdout-limit') return { ok: false, reason: 'total-bytes' }
      return { ok: false, reason: 'unavailable' }
    }
    return { ok: false, reason: 'unavailable' }
  }
}

async function checkpointExpectedPatchView(
  dependencies: LocalProjectDiffDependencies,
  binding: ActiveHostProjectBinding,
  observed: BoundProjectObservation,
  repository: SafeRepositoryView,
  signal: AbortSignal,
): Promise<ProjectGitDiffFailureReason | undefined> {
  const failure = await revalidateExpectedObservation(
    dependencies,
    binding,
    observed.status.fingerprint,
    signal,
  )
  if (failure !== undefined) return failure
  await repository.assertSourceControlUnchanged(signal)
  return undefined
}

async function revalidateExpectedObservation(
  dependencies: LocalProjectDiffDependencies,
  binding: ActiveHostProjectBinding,
  expectedStatus: ProjectGitStatusFingerprint,
  signal: AbortSignal,
): Promise<ProjectGitDiffFailureReason | undefined> {
  const current = await observeBoundProject(dependencies, binding, signal)
  if (!current.ok) return current.reason
  return sameStatusFingerprint(current.value.status.fingerprint, expectedStatus)
    ? undefined
    : 'observation-stale'
}

async function runDiffQuery(
  repository: SafeRepositoryView,
  args: readonly string[],
  signal: AbortSignal,
  maxOutputBytes: number,
): Promise<Buffer> {
  let observedBytes = 0
  const budget: RawOutputBudget = {
    observe(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxOutputBytes - observedBytes) return false
      observedBytes += bytes
      return true
    },
  }
  const output = await repository.git.run(repository.topLevelPath, args, signal, undefined, budget)
  if (output.stderr.byteLength !== 0) throw new GitCommandError('stream-failure')
  return output.stdout
}

async function boundViewAdmission(
  dependencies: LocalProjectDiffDependencies,
  binding: ActiveHostProjectBinding,
  observed: BoundProjectObservation,
  repository: SafeRepositoryView,
  signal: AbortSignal,
): Promise<ProjectGitDiffFailureReason | undefined> {
  const expected = binding.expectedInspection.trusted
  if (repository.topLevelPath !== expected.canonicalWorktreePath
    || repository.gitDirectoryPath !== expected.canonicalGitDirectory
    || repository.commonDirectoryPath !== expected.canonicalCommonGitDirectory
    || repository.locked !== observed.inspection.projection.locked) {
    return 'binding-stale'
  }
  const workspaceMatches = dependencies.workspaces.list()
    .filter(workspace => workspace.path === repository.topLevelPath)
  if (workspaceMatches.length !== 1 || workspaceMatches[0]?.id !== binding.workspaceId) {
    return 'binding-stale'
  }
  const gitIdentity = await dependencies.identityReader(repository.gitDirectoryPath, signal)
  const commonIdentity = repository.commonDirectoryPath === repository.gitDirectoryPath
    ? gitIdentity
    : await dependencies.identityReader(repository.commonDirectoryPath, signal)
  return projectDiffAdministrativeIdentityFailure(
    gitIdentity.digest,
    expected.gitDirectoryIdentity.digest,
    commonIdentity.digest,
    expected.commonGitDirectoryIdentity.digest,
  )
}

function resolveInventoryEntries(
  inventory: CapturedRepositoryInventory,
  change: ProjectGitChange,
) {
  const expected = Buffer.from(change.path, 'utf8')
  return inventory.entries
    .filter(entry => Buffer.compare(Buffer.from(entry.path), expected) === 0)
}

function changeHasLayer(
  change: Extract<ProjectGitChange, { readonly kind: 'ordinary' }>,
  layer: ReadableProjectGitDiffLayer,
): boolean {
  return layer === 'staged'
    ? change.indexStatus !== 'unchanged'
    : change.worktreeStatus !== 'unchanged'
}

/**
 * Parse one exact NUL-framed file `--numstat` result without decoding its path.
 * @param bytes - complete bounded Git stdout.
 * @param expectedPath - exact raw path selected from repository inventory.
 * @returns the represented content kind or a closed malformed classification.
 */
export function parseProjectDiffBinaryPreflight(
  bytes: Uint8Array,
  expectedPath: Uint8Array,
): 'text' | 'binary' | 'missing' | 'malformed' {
  if (bytes.byteLength === 0) return 'missing'
  if (bytes.at(-1) !== 0 || bytes.indexOf(0) !== bytes.byteLength - 1) return 'malformed'
  const record = bytes.subarray(0, -1)
  const firstTab = record.indexOf(9)
  const secondTab = firstTab < 0 ? -1 : record.indexOf(9, firstTab + 1)
  if (firstTab <= 0 || secondTab <= firstTab + 1) return 'malformed'
  const added = record.subarray(0, firstTab)
  const deleted = record.subarray(firstTab + 1, secondTab)
  const path = record.subarray(secondTab + 1)
  if (!Buffer.from(path).equals(Buffer.from(expectedPath))) return 'malformed'
  const addedBinary = added.byteLength === 1 && added[0] === 45
  const deletedBinary = deleted.byteLength === 1 && deleted[0] === 45
  if (addedBinary || deletedBinary) return addedBinary && deletedBinary ? 'binary' : 'malformed'
  return canonicalDecimal(added) && canonicalDecimal(deleted) ? 'text' : 'malformed'
}

function canonicalDecimal(bytes: Uint8Array): boolean {
  if (bytes.byteLength > 1 && bytes[0] === 48) return false
  return bytes.every(byte => byte >= 48 && byte <= 57)
}

/**
 * Parse and bound one complete unified Diff patch.
 * @param bytes - complete raw patch stdout.
 * @returns decoded logical lines or one browser-safe failure.
 */
export function parseProjectDiffPatch(bytes: Buffer):
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly reason: ProjectGitDiffFailureReason } {
  if (bytes.byteLength === 0 || bytes.at(-1) !== 10 || bytes.includes(0)) {
    return { ok: false, reason: 'malformed' }
  }
  if (bytes.byteLength > MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES) {
    return { ok: false, reason: 'total-bytes' }
  }
  let text: string
  try {
    text = UTF8.decode(bytes)
  } catch {
    return { ok: false, reason: 'invalid-utf8' }
  }
  const lines = text.slice(0, -1).split('\n')
  if (lines.length > MAX_PROJECT_GIT_DIFF_TOTAL_LINES) return { ok: false, reason: 'total-lines' }
  if (lines.some(line => Buffer.byteLength(line, 'utf8') + 1 > MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES)) {
    return { ok: false, reason: 'line-bytes' }
  }
  return { ok: true, lines }
}

function buildPage(
  request: LocalProjectDiffRequest,
  lines: readonly string[],
  totalUtf8Bytes: number,
  patchDigest: string,
  startLine: number,
): ProjectGitDiffPage {
  let endLineExclusive = startLine
  let pageUtf8Bytes = 0
  for (const line of lines.slice(startLine, startLine + MAX_PROJECT_GIT_DIFF_PAGE_LINES)) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1
    if (lineBytes > MAX_PROJECT_GIT_DIFF_PAGE_UTF8_BYTES - pageUtf8Bytes) break
    pageUtf8Bytes += lineBytes
    endLineExclusive += 1
  }
  const pageLines = lines.slice(startLine, endLineExclusive)
  const omittedAfterLines = lines.length - endLineExclusive
  return {
    pageVersion: 1,
    observation: request.expectedStatus,
    changeId: request.changeId,
    layer: request.layer,
    patchFingerprint: { version: 1, digest: patchDigest },
    range: { startLine, endLineExclusive, totalLines: lines.length },
    lines: pageLines,
    pageUtf8Bytes,
    totalUtf8Bytes,
    omittedBeforeLines: startLine,
    omittedAfterLines,
    truncated: startLine > 0 || omittedAfterLines > 0,
    ...(omittedAfterLines === 0
      ? {}
      : {
        nextCursor: encodeCursor({
          version: 1,
          observationDigest: request.expectedStatus.digest,
          changeId: request.changeId,
          layer: request.layer,
          patchDigest,
          nextLine: endLineExclusive,
        }),
      }),
  }
}

function encodeCursor(material: DiffCursorMaterial): ProjectGitDiffCursor {
  return Buffer.from(JSON.stringify(material), 'utf8').toString('base64url') as ProjectGitDiffCursor
}

function decodeCursor(cursor: ProjectGitDiffCursor):
  | { readonly ok: true; readonly value: DiffCursorMaterial }
  | { readonly ok: false } {
  if (cursor.length === 0 || cursor.length > MAX_PROJECT_GIT_DIFF_CURSOR_CHARS
    || !/^[A-Za-z0-9_-]+$/u.test(cursor)) return { ok: false }
  let bytes: Buffer
  let value: unknown
  try {
    bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) return { ok: false }
    value = JSON.parse(UTF8.decode(bytes)) as unknown
  } catch {
    return { ok: false }
  }
  if (!isCursorMaterial(value) || encodeCursor(value) !== cursor) return { ok: false }
  return { ok: true, value }
}

function isCursorMaterial(value: unknown): value is DiffCursorMaterial {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === 6
    && keys[0] === 'version'
    && keys[1] === 'observationDigest'
    && keys[2] === 'changeId'
    && keys[3] === 'layer'
    && keys[4] === 'patchDigest'
    && keys[5] === 'nextLine'
    && record.version === 1
    && typeof record.observationDigest === 'string'
    && /^[0-9a-f]{64}$/u.test(record.observationDigest)
    && typeof record.changeId === 'string'
    && record.changeId.length > 0
    && (record.layer === 'staged' || record.layer === 'unstaged' || record.layer === 'conflict')
    && typeof record.patchDigest === 'string'
    && /^[0-9a-f]{64}$/u.test(record.patchDigest)
    && typeof record.nextLine === 'number'
    && Number.isSafeInteger(record.nextLine)
    && record.nextLine > 0
    && record.nextLine < MAX_PROJECT_GIT_DIFF_TOTAL_LINES
}

function sameStatusFingerprint(
  left: ProjectGitStatusFingerprint,
  right: ProjectGitStatusFingerprint,
): boolean {
  return left.digest === right.digest
}

function decodePath(path: Uint8Array): string | undefined {
  try {
    return UTF8.decode(path)
  } catch {
    return undefined
  }
}

/**
 * Compare the two admitted Git administrative-directory identities with their Binding evidence.
 * @param gitDirectoryDigest - Current Git directory identity digest.
 * @param expectedGitDirectoryDigest - Git directory identity digest retained by the Binding.
 * @param commonDirectoryDigest - Current common Git directory identity digest.
 * @param expectedCommonDirectoryDigest - Common Git directory identity digest retained by the Binding.
 * @returns `binding-stale` when either identity changed; otherwise `undefined`.
 * @internal
 */
export function projectDiffAdministrativeIdentityFailure(
  gitDirectoryDigest: string,
  expectedGitDirectoryDigest: string,
  commonDirectoryDigest: string,
  expectedCommonDirectoryDigest: string,
): 'binding-stale' | undefined {
  return gitDirectoryDigest === expectedGitDirectoryDigest
    && commonDirectoryDigest === expectedCommonDirectoryDigest
    ? undefined
    : 'binding-stale'
}

/**
 * Project a stable-selection failure onto the public Diff failure vocabulary.
 * @param reason - Local selection failure category.
 * @returns browser-safe Diff failure category.
 * @internal
 */
export function projectDiffSelectionFailureReason(
  reason: StableLocalProjectSelectionFailureReason,
): ProjectGitDiffFailureReason {
  return PROJECT_DIFF_SELECTION_FAILURE_REASONS[reason]
}

const PROJECT_DIFF_SELECTION_FAILURE_REASONS = {
  malformed: 'malformed',
  ambiguous: 'ambiguous',
  unavailable: 'unavailable',
  limit: 'unavailable',
  'unsupported-index-state': 'unavailable',
  missing: 'binding-stale',
  'not-directory': 'binding-stale',
  'not-git': 'binding-stale',
  bare: 'binding-stale',
  prunable: 'binding-stale',
} as const satisfies Readonly<Record<StableLocalProjectSelectionFailureReason, ProjectGitDiffFailureReason>>

/**
 * Project a private repository-view failure onto the public Diff failure vocabulary.
 * @param reason - Local repository-view failure category.
 * @returns browser-safe Diff failure category.
 * @internal
 */
export function projectDiffRepositoryOpenFailureReason(
  reason: Exclude<SafeRepositoryOpenResult['kind'], 'repository'>,
): ProjectGitDiffFailureReason {
  return PROJECT_DIFF_REPOSITORY_OPEN_FAILURE_REASONS[reason]
}

const PROJECT_DIFF_REPOSITORY_OPEN_FAILURE_REASONS = {
  malformed: 'malformed',
  ambiguous: 'ambiguous',
  unavailable: 'unavailable',
  'not-git': 'binding-stale',
  bare: 'binding-stale',
  prunable: 'binding-stale',
} as const satisfies Readonly<
  Record<Exclude<SafeRepositoryOpenResult['kind'], 'repository'>, ProjectGitDiffFailureReason>
>
