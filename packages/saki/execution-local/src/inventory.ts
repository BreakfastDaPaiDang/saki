/** Closed raw-byte repository inventory for Local Host inspection. @module @breakfastdapaidang/saki-execution-local/inventory */

import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { RawCommandOutput } from './git-runner.ts'
import type { RawOutputBudget } from './git-runner.ts'
import { GitCommandError } from './git-runner.ts'
import {
  capturedInventoryEntryHasGitlink,
  type CapturedInventoryGitObject,
  type CapturedInventoryWorktree,
  type CapturedRepositoryInventory,
  type CapturedRepositoryInventoryEntry,
} from './baseline.ts'
import { exactBytesDigest } from './canonical.ts'
import {
  GitInventoryLimitError,
  parseCheckAttrConversion,
  parseLsFilesStage,
  parseLsTree,
  parseNulPaths,
  type ParsedIndexEntry,
} from './git-observation.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** Independent bounds for complete repository membership and raw comparison. */
export interface RepositoryInventoryBounds {
  readonly maxEntries: number
  readonly maxPathBytes: number
  readonly maxGitOutputBytes: number
  readonly maxFileBytes: number
  readonly maxTotalFileBytes: number
  readonly maxCaptureMs: number
}

/** Minimal raw Git execution face used by inventory capture. */
export interface RepositoryInventoryGit {
  run(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal,
    stdin?: { readonly bytes: Uint8Array; readonly maxBytes: number },
    outputBudget?: RawOutputBudget,
  ): Promise<RawCommandOutput>
}

/** Exact private-index flag evidence retained across both observation rounds. */
export interface RepositoryIndexFlagEvidence {
  /** Whether structured mutation must fail closed for this index state. */
  readonly mutationBlocked: boolean
  /** Exact stage-zero CE_VALID paths whose hidden ordinary status may be reconstructed. */
  readonly assumeUnchangedPaths: readonly Uint8Array[]
  /** Digest of the sparse-config fact and complete raw flag output. */
  readonly identity: string
}

/**
 * Inspect index flags that are not represented by the index tree identity.
 * @param git - Git runner bound to one admitted private repository view.
 * @param cwd - canonical worktree path associated with the private view.
 * @param signal - observation lifetime.
 * @param inventory - same-round stage-zero membership for exact cross-checking.
 * @param sparseIndexEnabled - admitted repository-local sparse configuration fact.
 * @returns exact flag evidence plus candidate paths eligible for raw-inventory reconciliation.
 */
export async function captureRepositoryIndexFlagEvidence(
  git: RepositoryInventoryGit,
  cwd: string,
  signal: AbortSignal,
  inventory: CapturedRepositoryInventory,
  sparseIndexEnabled: boolean,
): Promise<RepositoryIndexFlagEvidence> {
  const { stdout, stderr } = await git.run(cwd, ['ls-files', '-v', '-z', '--'], signal)
  if (stderr.byteLength !== 0) throw new RepositoryInventoryError('unavailable')
  if (stdout.byteLength !== 0 && stdout.at(-1) !== 0) throw new RepositoryInventoryError('malformed')
  const expected = expectedIndexFlagEntries(inventory)
  let anomaly = false
  let mutationBlocked = sparseIndexEnabled
  const assumeUnchangedPaths: Uint8Array[] = []
  let start = 0
  while (start < stdout.byteLength) {
    const end = stdout.indexOf(0, start)
    if (end < 0 || end - start < 3 || stdout[start + 1] !== 0x20) {
      throw new RepositoryInventoryError('malformed')
    }
    const tag = String.fromCharCode(stdout[start] as number)
    const normalizedTag = tag.toUpperCase()
    if (!/^[HSMRCK?]$/u.test(normalizedTag)) throw new RepositoryInventoryError('malformed')
    const path = stdout.subarray(start + 2, end)
    const key = Buffer.from(path).toString('hex')
    const entry = expected.get(key)
    if (entry === undefined || entry.observed >= entry.count) {
      anomaly = true
    } else {
      entry.observed += 1
      const expectedTag = entry.kind === 'conflict' ? 'M' : entry.skipWorktree ? 'S' : 'H'
      if (normalizedTag !== expectedTag) {
        anomaly = true
      } else if (tag === 'h') {
        mutationBlocked = true
        if (!capturedInventoryEntryHasGitlink(entry.inventoryEntry)) {
          assumeUnchangedPaths.push(path.subarray())
        }
      } else if (tag === 's' || tag === 'm' || tag === 'S') {
        mutationBlocked = true
      }
    }
    start = end + 1
  }
  if ([...expected.values()].some(entry => entry.observed !== entry.count)) anomaly = true
  if (anomaly) mutationBlocked = true
  assumeUnchangedPaths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const identityMaterial = new Uint8Array(stdout.byteLength + 1)
  identityMaterial[0] = sparseIndexEnabled ? 1 : 0
  identityMaterial.set(stdout, 1)
  return {
    mutationBlocked,
    assumeUnchangedPaths: anomaly ? [] : assumeUnchangedPaths,
    identity: exactBytesDigest('saki/repository-index-flags/v1', identityMaterial),
  }
}

interface ExpectedIndexFlagEntry {
  readonly kind: 'stage-zero' | 'conflict'
  readonly skipWorktree: boolean
  readonly count: number
  readonly inventoryEntry: CapturedRepositoryInventoryEntry
  observed: number
}

function expectedIndexFlagEntries(
  inventory: CapturedRepositoryInventory,
): Map<string, ExpectedIndexFlagEntry> {
  const entries = new Map<string, ExpectedIndexFlagEntry>()
  for (const entry of inventory.entries) {
    const conflictStages = entry.stages.filter(stage => stage !== undefined).length
    const count = entry.index === undefined ? conflictStages : 1
    if (count === 0) continue
    const key = Buffer.from(entry.path).toString('hex')
    entries.set(key, {
      kind: entry.index === undefined ? 'conflict' : 'stage-zero',
      skipWorktree: entry.skipWorktree === true,
      count,
      inventoryEntry: entry,
      observed: 0,
    })
  }
  return entries
}

/** One aggregate observation lifetime shared by every Git fact in a round. */
export interface RepositoryObservationRound extends Disposable {
  readonly git: RepositoryInventoryGit
  readonly signal: AbortSignal
  /** Reject when caller cancellation or the aggregate wall-clock limit has elapsed. */
  check(): void
}

/** Bounded current object observation for one initialized gitlink. */
export interface SubmoduleObjectObservation {
  readonly objectId: string
  readonly semanticGitOutputBytes: number
}

/** Safe reader for one initialized gitlink and its nested administrative identity. */
export type SubmoduleObjectReader = (
  path: string,
  signal: AbortSignal,
) => Promise<SubmoduleObjectObservation | undefined>

/** Injectable raw filesystem facts used to prove capture stability. */
export interface RepositoryInventoryFileFacts {
  lstat(path: string): Promise<BigIntStats>
  readlink(path: string): Promise<Buffer>
  realpath(path: string): Promise<string>
  open(path: string): ReturnType<typeof open>
}

const NODE_FILE_FACTS: RepositoryInventoryFileFacts = {
  async lstat(path) { return await lstat(path, { bigint: true }) },
  async readlink(path) { return await readlink(path, { encoding: 'buffer' }) },
  async realpath(path) { return await realpath(path) },
  async open(path) { return await open(path, 'r') },
}

/** Closed failure class used to distinguish malformed Git from unavailable capture. */
export class RepositoryInventoryError extends Error {
  /** @param kind - safe inspection rejection class. */
  constructor(readonly kind: 'malformed' | 'unavailable') {
    super(`Saki repository inventory ${kind}`)
  }
}

/**
 * Bound every Git command in one repository observation by one output ledger
 * and one wall-clock lifetime.
 * @param git - bounded per-command Git runner.
 * @param bounds - complete observation aggregate limits.
 * @param signal - required caller cancellation.
 * @returns disposable aggregate observation runner.
 */
export function createRepositoryObservationRound(
  git: RepositoryInventoryGit,
  bounds: RepositoryInventoryBounds,
  signal: AbortSignal,
): RepositoryObservationRound {
  const startedAt = performance.now()
  const lifetime = deadline(signal, bounds.maxCaptureMs, 'SAKI_OBSERVATION_TIMEOUT')
  let gitOutputBytes = 0
  const check = (): void => {
    signal.throwIfAborted()
    if (lifetime.signal.aborted || performance.now() - startedAt > bounds.maxCaptureMs) {
      throw new RepositoryInventoryError('unavailable')
    }
  }
  const outputBudget: RawOutputBudget = {
    observe(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > bounds.maxGitOutputBytes - gitOutputBytes) {
        return false
      }
      gitOutputBytes += bytes
      return true
    },
  }
  const observed: RepositoryInventoryGit = {
    async run(cwd, args, commandSignal, stdin) {
      check()
      const output = await git.run(
        cwd,
        args,
        AbortSignal.any([lifetime.signal, commandSignal]),
        stdin,
        outputBudget,
      )
      if (output.stderr.byteLength !== 0) {
        throw new RepositoryInventoryError('unavailable')
      }
      check()
      return output
    },
  }
  return {
    git: observed,
    signal: lifetime.signal,
    check,
    [Symbol.dispose]() { lifetime[Symbol.dispose]() },
  }
}

class CurrentEvidenceError extends Error {
  constructor(
    readonly reason: import('@breakfastdapaidang/saki-execution').InheritedChangeBaselineUnavailableReason,
    readonly changeKnown = false,
  ) {
    super(reason)
  }
}

interface MutableInventoryEntry {
  readonly path: Uint8Array
  head?: CapturedInventoryGitObject
  index?: CapturedInventoryGitObject
  readonly stages: [
    CapturedInventoryGitObject | undefined,
    CapturedInventoryGitObject | undefined,
    CapturedInventoryGitObject | undefined,
  ]
  skipWorktree?: boolean
  untracked: boolean
}

interface CaptureState {
  readonly root: string
  readonly objectFormat: 'sha1' | 'sha256'
  readonly bounds: RepositoryInventoryBounds
  readonly signal: AbortSignal
  readonly startedAt: number
  readonly facts: RepositoryInventoryFileFacts
  identities: Set<string>
  consumedRawBytes: number
  retainedRawBytes: number
  gitOutputBytes: number
}

interface IdentityTransaction {
  added?: string
}

/**
 * Capture one complete HEAD/index/untracked/current raw-byte inventory.
 * @param root - canonical selected Git top-level.
 * @param git - bounded structured Git execution.
 * @param objectFormat - selected repository object format.
 * @param bounds - independent complete-inventory resource limits.
 * @param signal - required caller cancellation.
 * @param readSubmoduleObject - safe nested-repository object reader.
 * @param facts - injectable raw filesystem facts for deterministic race rejection.
 * @param headObjectId - exact commit tree to inventory, or null for an unborn empty HEAD tree.
 * @returns complete joined inventory with no plaintext path projection.
 */
export async function captureRepositoryInventory(
  root: string,
  git: RepositoryInventoryGit,
  objectFormat: 'sha1' | 'sha256',
  bounds: RepositoryInventoryBounds,
  signal: AbortSignal,
  readSubmoduleObject?: SubmoduleObjectReader,
  facts: RepositoryInventoryFileFacts = NODE_FILE_FACTS,
  headObjectId: string | null = 'HEAD',
): Promise<CapturedRepositoryInventory> {
  using lifetime = deadline(signal, bounds.maxCaptureMs, 'SAKI_INVENTORY_TIMEOUT')
  const state: CaptureState = {
    root,
    objectFormat,
    bounds,
    signal: lifetime.signal,
    startedAt: performance.now(),
    facts,
    identities: new Set(),
    consumedRawBytes: 0,
    retainedRawBytes: 0,
    gitOutputBytes: 0,
  }
  signal.throwIfAborted()
  try {
    await rejectConfigIncludes(state, git)
    const treeBytes = headObjectId === null
      ? new Uint8Array()
      : (await runObserved(state, git, ['ls-tree', '-r', '--full-tree', '-z', headObjectId])).stdout
    const indexOutput = await runObserved(
      state,
      git,
      ['ls-files', '--no-sparse', '-t', '--stage', '--full-name', '-z'],
    )
    const untrackedOutput = await runObserved(state, git, [
      'ls-files', '--others', '--exclude-standard', '--full-name', '-z',
    ])
    let tree: ReturnType<typeof parseLsTree>
    let index: ReturnType<typeof parseLsFilesStage>
    let untracked: ReturnType<typeof parseNulPaths>
    try {
      tree = parseLsTree(treeBytes, bounds)
      index = parseLsFilesStage(indexOutput.stdout, bounds)
      untracked = parseNulPaths(untrackedOutput.stdout, bounds)
    } catch (error) {
      if (error instanceof GitInventoryLimitError) throw new RepositoryInventoryError('unavailable')
      throw new RepositoryInventoryError('malformed')
    }
    validateObjectWidths(objectFormat, tree.map(entry => entry.objectId), index.map(entry => entry.objectId))
    const entries = joinMembership(tree, index, untracked)
    enforceMembershipBounds(entries, bounds)
    checkTime(state)

    const comparison = {
      fileMode: await readBooleanConfig(state, git, 'core.fileMode', true),
      symlinks: await readBooleanConfig(state, git, 'core.symlinks', true),
      autocrlf: await readAutocrlf(state, git),
    }
    const observedEntries: Array<{
      readonly entry: MutableInventoryEntry
      readonly current: CapturedInventoryWorktree
    }> = []
    for (const entry of entries) {
      checkTime(state)
      state.signal.throwIfAborted()
      const identityTransaction: IdentityTransaction = {}
      let current: CapturedInventoryWorktree
      try {
        current = await captureCurrent(entry, comparison, state, identityTransaction, readSubmoduleObject)
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (state.signal.aborted) throw new RepositoryInventoryError('unavailable')
        if (error instanceof RepositoryInventoryError) throw error
        if (!changeKnownWithoutCurrent(entry)
          && !(error instanceof CurrentEvidenceError && error.changeKnown)) throw error
        if (identityTransaction.added !== undefined) state.identities.delete(identityTransaction.added)
        current = {
          kind: 'unavailable',
          reason: error instanceof CurrentEvidenceError ? error.reason : 'io-failure',
        }
      }
      if (current.kind === 'captured') {
        state.retainedRawBytes = checkedAdd(state.retainedRawBytes, current.rawByteLength)
      }
      observedEntries.push({ entry, current })
    }

    const attributePaths = observedEntries
      .filter(({ entry, current }) => stageableBlobPath(entry, current))
      .map(({ entry }) => entry.path)
    const attributeInput = nulFramePaths(attributePaths)
    const attributeOutput = await runObserved(
      state,
      git,
      ['check-attr', '--all', '-z', '--stdin'],
      { bytes: attributeInput, maxBytes: attributeInput.byteLength },
    )
    let conversions: ReturnType<typeof parseCheckAttrConversion>
    try {
      conversions = parseCheckAttrConversion(attributeOutput.stdout, attributePaths)
    } catch {
      throw new RepositoryInventoryError('malformed')
    }
    const conversionByPath = new Map(conversions.map(value => [pathKey(value.path), value]))

    const captured: CapturedRepositoryInventoryEntry[] = []
    for (const { entry, current } of observedEntries) {
      const conversion = conversionByPath.get(pathKey(entry.path)) ?? {
        executableFilter: false,
        unmodeled: false,
        lineEnding: false,
      }
      captured.push({ ...entry, current, conversion })
    }
    checkTime(state)
    const elapsedMs = Math.ceil(performance.now() - state.startedAt)
    if (elapsedMs > bounds.maxCaptureMs) throw new RepositoryInventoryError('unavailable')
    return {
      objectFormat,
      comparison,
      allowlistedGitEvidenceBytes:
        treeBytes.byteLength + indexOutput.stdout.byteLength + untrackedOutput.stdout.byteLength,
      capture: { elapsedMs, rawBytes: state.retainedRawBytes },
      entries: captured,
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (lifetime.signal.aborted) throw new RepositoryInventoryError('unavailable')
    if (error instanceof RepositoryInventoryError || error instanceof GitCommandError) throw error
    throw new RepositoryInventoryError('unavailable')
  }
}

async function runObserved(
  state: CaptureState,
  git: RepositoryInventoryGit,
  args: readonly string[],
  stdin?: { readonly bytes: Uint8Array; readonly maxBytes: number },
): Promise<RawCommandOutput> {
  checkTime(state)
  const output = await git.run(state.root, args, state.signal, stdin)
  if (output.stderr.byteLength !== 0) throw new RepositoryInventoryError('unavailable')
  state.gitOutputBytes = checkedAdd(state.gitOutputBytes, output.stdout.byteLength)
  if (state.gitOutputBytes > state.bounds.maxGitOutputBytes) throw new RepositoryInventoryError('unavailable')
  checkTime(state)
  return output
}

function joinMembership(
  tree: ReturnType<typeof parseLsTree>,
  index: readonly ParsedIndexEntry[],
  untracked: readonly Uint8Array[],
): MutableInventoryEntry[] {
  const entries = new Map<string, MutableInventoryEntry>()
  const get = (path: Uint8Array): MutableInventoryEntry => {
    if (path[path.length - 1] === 0x2f) throw new RepositoryInventoryError('unavailable')
    const key = pathKey(path)
    const existing = entries.get(key)
    if (existing !== undefined) return existing
    const created: MutableInventoryEntry = {
      path: path.slice(), stages: [undefined, undefined, undefined], untracked: false,
    }
    entries.set(key, created)
    return created
  }
  for (const value of tree) get(value.path).head = { mode: value.mode, objectId: value.objectId }
  for (const value of index) {
    if (value.mode === '040000') throw new RepositoryInventoryError('unavailable')
    const entry = get(value.path)
    const object = { mode: value.mode, objectId: value.objectId } as CapturedInventoryGitObject
    if (value.stage === 0) {
      entry.index = object
      if (value.tag === 'S') entry.skipWorktree = true
    }
    else entry.stages[value.stage - 1] = object
  }
  for (const path of untracked) {
    const entry = get(path)
    if (entry.index !== undefined || entry.stages.some(stage => stage !== undefined) || entry.untracked) {
      throw new RepositoryInventoryError('malformed')
    }
    entry.untracked = true
  }
  return [...entries.values()].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
}

function enforceMembershipBounds(
  entries: readonly MutableInventoryEntry[],
  bounds: RepositoryInventoryBounds,
): void {
  if (entries.length > bounds.maxEntries) throw new RepositoryInventoryError('unavailable')
  let pathBytes = 0
  for (const entry of entries) {
    pathBytes = checkedAdd(pathBytes, entry.path.byteLength)
    if (pathBytes > bounds.maxPathBytes) throw new RepositoryInventoryError('unavailable')
  }
}

function validateObjectWidths(
  format: 'sha1' | 'sha256',
  ...groups: readonly (readonly string[])[]
): void {
  const width = format === 'sha1' ? 40 : 64
  if (groups.some(group => group.some(objectId => objectId.length !== width))) {
    throw new RepositoryInventoryError('malformed')
  }
}

async function readBooleanConfig(
  state: CaptureState,
  git: RepositoryInventoryGit,
  key: string,
  fallback: boolean,
): Promise<boolean> {
  const values = await readConfigValues(state, git, key, 'bool')
  const value = values.at(-1)
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new RepositoryInventoryError('malformed')
}

async function readAutocrlf(state: CaptureState, git: RepositoryInventoryGit): Promise<boolean> {
  try {
    const values = await readConfigValues(state, git, 'core.autocrlf', 'bool')
    const value = values.at(-1)
    if (value === undefined) return false
    if (value === 'true') return true
    if (value === 'false') return false
    throw new RepositoryInventoryError('malformed')
  } catch (error) {
    if (!(error instanceof GitCommandError && error.code === 'nonzero')) throw error
    const values = await readConfigValues(state, git, 'core.autocrlf')
    const value = values.at(-1)?.toLowerCase()
    if (value === 'input') return true
    const parsed = value === undefined ? undefined : parseGitBoolean(value)
    if (parsed !== undefined) return parsed
    throw new RepositoryInventoryError('unavailable')
  }
}

function parseGitBoolean(value: string): boolean | undefined {
  if (value === '' || value === 'false' || value === 'no' || value === 'off') return false
  if (value === 'true' || value === 'yes' || value === 'on') return true
  if (!/^[+-]?[0-9]+$/u.test(value)) return undefined
  const digits = value[0] === '+' || value[0] === '-' ? value.slice(1) : value
  return /[1-9]/u.test(digits)
}

async function readConfigValues(
  state: CaptureState,
  git: RepositoryInventoryGit,
  key: string,
  type?: 'bool',
): Promise<string[]> {
  let output: RawCommandOutput
  try {
    output = await runObserved(state, git, [
      'config', '--no-includes', '--null', ...(type === undefined ? [] : [`--type=${type}`]), '--get-all', key,
    ])
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 'nonzero' && error.exitCode === 1) return []
    throw error
  }
  return splitConfigNul(output.stdout).map(value => decode(value))
}

async function rejectConfigIncludes(state: CaptureState, git: RepositoryInventoryGit): Promise<void> {
  const output = await runObserved(state, git, [
    'config', '--no-includes', '--null', '--name-only', '--list',
  ])
  for (const raw of splitNul(output.stdout)) {
    if (isGitConfigIncludeName(decode(raw))) {
      throw new RepositoryInventoryError('unavailable')
    }
  }
}

/**
 * Recognize Git include declarations without resolving their paths or conditions.
 * @param name - one complete Git config key.
 * @returns whether the key declares an unconditional or conditional include.
 */
export function isGitConfigIncludeName(name: string): boolean {
  const key = name.toLowerCase()
  return key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))
}

function stageableBlobPath(entry: MutableInventoryEntry, current: CapturedInventoryWorktree): boolean {
  if (current.kind === 'captured'
    && (current.evidence.kind === 'regular' || current.evidence.kind === 'symlink')) return true
  if (entry.untracked) return true
  return [entry.head, entry.index, ...entry.stages]
    .some(object => object !== undefined && object.mode !== '160000')
}

function changeKnownWithoutCurrent(entry: MutableInventoryEntry): boolean {
  if (entry.untracked || entry.stages.some(stage => stage !== undefined)) return true
  if (entry.head === undefined || entry.index === undefined) return entry.head !== entry.index
  return entry.head.mode !== entry.index.mode || entry.head.objectId !== entry.index.objectId
}

function nulFramePaths(paths: readonly Uint8Array[]): Buffer {
  const pathBytes = paths.reduce((total, path) => checkedAdd(total, path.byteLength), 0)
  const total = checkedAdd(pathBytes, paths.length)
  return Buffer.concat(paths.flatMap(path => [Buffer.from(path), Buffer.from([0])]), total)
}

async function captureCurrent(
  entry: MutableInventoryEntry,
  comparison: CapturedRepositoryInventory['comparison'],
  state: CaptureState,
  identityTransaction: IdentityTransaction,
  readSubmoduleObject: SubmoduleObjectReader | undefined,
): Promise<CapturedInventoryWorktree> {
  const path = resolveInventoryPath(state.root, entry.path)
  const parent = dirname(path)
  const beforeParent = await resolveExistingAncestor(state, parent)
  const current = await captureCurrentAtPath(path, entry, comparison, state, identityTransaction, readSubmoduleObject)
  const afterParent = await resolveExistingAncestor(state, parent)
  if (beforeParent.path !== afterParent.path || beforeParent.identity !== afterParent.identity
    || !sameStat(beforeParent.entry, afterParent.entry)
    || !sameStat(beforeParent.target, afterParent.target)) {
    throw new CurrentEvidenceError('unstable-content')
  }
  return current
}

async function captureCurrentAtPath(
  path: string,
  entry: MutableInventoryEntry,
  comparison: CapturedRepositoryInventory['comparison'],
  state: CaptureState,
  identityTransaction: IdentityTransaction,
  readSubmoduleObject: SubmoduleObjectReader | undefined,
): Promise<CapturedInventoryWorktree> {
  let info: BigIntStats
  try {
    info = await state.facts.lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      await state.facts.lstat(path)
    } catch (confirmation) {
      if ((confirmation as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'captured', evidence: { kind: 'missing' }, rawByteLength: 0, gitEvidenceBytes: 0 }
      }
      throw confirmation
    }
    throw new CurrentEvidenceError('unstable-content')
  }
  rememberIdentity(info, state, identityTransaction)
  checkTime(state)
  state.signal.throwIfAborted()
  const changeKnown = currentKindProvesChange(entry, info, comparison)
  try {
    if (info.isDirectory()) {
      if (!hasGitlinkEvidence(entry) || readSubmoduleObject === undefined) {
        throw new CurrentEvidenceError('unsupported-state')
      }
      const first = await readSubmoduleObject(path, state.signal)
      if (first !== undefined && !objectMatchesFormat(first.objectId, state.objectFormat)) {
        throw new RepositoryInventoryError('malformed')
      }
      if (first === undefined) {
        return await unavailablePresentGitlink(path, info, state, 'unsupported-state')
      }
      observeNestedGitBytes(state, first.semanticGitOutputBytes)
      const after = await state.facts.lstat(path)
      const second = await readSubmoduleObject(path, state.signal)
      if (second === undefined) {
        if (!after.isDirectory() || !sameStat(info, after)) {
          throw new CurrentEvidenceError('unstable-content')
        }
        return await unavailablePresentGitlink(path, info, state, 'unsupported-state')
      }
      if (!objectMatchesFormat(second.objectId, state.objectFormat)) {
        throw new RepositoryInventoryError('malformed')
      }
      observeNestedGitBytes(state, second.semanticGitOutputBytes)
      const confirmed = await state.facts.lstat(path)
      if (!after.isDirectory() || !confirmed.isDirectory() || !sameStat(info, after)
      || !sameStat(after, confirmed) || first.objectId !== second.objectId) {
        throw new CurrentEvidenceError('unstable-content')
      }
      return {
        kind: 'captured',
        evidence: { kind: 'submodule', objectId: first.objectId },
        rawObjectId: first.objectId,
        rawByteLength: 0,
        gitEvidenceBytes: checkedAdd(first.semanticGitOutputBytes, second.semanticGitOutputBytes),
      }
    }
    if (info.isSymbolicLink()) {
      enforceKnownRawSize(info.size, state)
      const target = await state.facts.readlink(path)
      enforceRawBytes(target.byteLength, state)
      const after = await state.facts.lstat(path)
      enforceKnownRawSize(after.size, state)
      const confirmedTarget = await state.facts.readlink(path)
      enforceRawBytes(confirmedTarget.byteLength, state)
      const confirmed = await state.facts.lstat(path)
      if (!after.isSymbolicLink() || !confirmed.isSymbolicLink() || !sameStat(info, after)
      || !sameStat(after, confirmed) || !target.equals(confirmedTarget)) {
        throw new CurrentEvidenceError('unstable-content')
      }
      return {
        kind: 'captured',
        evidence: { kind: 'symlink', targetDigest: exactBytesDigest('saki/inherited-symlink/v1', target) },
        rawObjectId: gitBlobId(state.objectFormat, target),
        rawByteLength: target.byteLength,
        gitEvidenceBytes: 0,
      }
    }
    if (!info.isFile()) throw new CurrentEvidenceError('unsupported-state')
    enforceKnownRawSize(info.size, state)
    const handle = await state.facts.open(path)
    try {
      const before = await handle.stat({ bigint: true })
      if (!sameStat(info, before)) throw new CurrentEvidenceError('unstable-content')
      enforceKnownRawSize(before.size, state)
      const gitHash = createHash(state.objectFormat)
      gitHash.update(`blob ${before.size}\0`)
      const contentHash = createHash('sha256')
      let byteLength = 0
      if (before.size > 0n) {
        const stream = handle.createReadStream({
          autoClose: false,
          start: 0,
          end: Number(before.size) - 1,
          signal: state.signal,
        })
        for await (const chunk of stream) {
          checkTime(state)
          state.signal.throwIfAborted()
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          enforceRawBytes(bytes.byteLength, state)
          byteLength = checkedAdd(byteLength, bytes.byteLength)
          if (byteLength > state.bounds.maxFileBytes) throw new CurrentEvidenceError('file-limit')
          gitHash.update(bytes)
          contentHash.update(bytes)
        }
      }
      const after = await handle.stat({ bigint: true })
      const pathAfter = await state.facts.lstat(path)
      if (!sameStat(before, after) || !pathAfter.isFile() || !sameStat(after, pathAfter)
      || BigInt(byteLength) !== after.size) {
        throw new CurrentEvidenceError('unstable-content')
      }
      return {
        kind: 'captured',
        evidence: {
          kind: 'regular',
          mode: executableMode(after.mode),
          byteLength,
          contentDigest: contentHash.digest('hex'),
        },
        rawObjectId: gitHash.digest('hex'),
        rawByteLength: byteLength,
        gitEvidenceBytes: 0,
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof RepositoryInventoryError) throw error
    if (error instanceof GitCommandError) throw error
    if (!changeKnown) throw error
    if (error instanceof CurrentEvidenceError) throw new CurrentEvidenceError(error.reason, true)
    throw new CurrentEvidenceError('io-failure', true)
  }
}

async function unavailablePresentGitlink(
  path: string,
  initial: BigIntStats,
  state: CaptureState,
  reason: import('@breakfastdapaidang/saki-execution').InheritedChangeBaselineUnavailableReason,
): Promise<CapturedInventoryWorktree> {
  const confirmed = await state.facts.lstat(path)
  if (!confirmed.isDirectory() || !sameStat(initial, confirmed)) {
    throw new CurrentEvidenceError('unstable-content')
  }
  return { kind: 'unavailable', reason, observedMode: '160000' }
}

function currentKindProvesChange(
  entry: MutableInventoryEntry,
  info: BigIntStats,
  comparison: CapturedRepositoryInventory['comparison'],
): boolean {
  const index = entry.index
  if (index === undefined) return false
  if (info.isDirectory()) return true
  if (info.isSymbolicLink()) return index.mode !== '120000'
  if (!info.isFile()) return true
  if (index.mode === '120000') return comparison.symlinks
  if (index.mode !== '100644' && index.mode !== '100755') return true
  return comparison.fileMode && executableMode(info.mode) !== index.mode
}

function hasGitlinkEvidence(entry: MutableInventoryEntry): boolean {
  return [entry.head, entry.index, ...entry.stages].some(value => value?.mode === '160000')
}

function enforceKnownRawSize(size: bigint, state: CaptureState): void {
  if (size > BigInt(state.bounds.maxFileBytes)) throw new CurrentEvidenceError('file-limit')
  const remaining = state.bounds.maxTotalFileBytes - state.consumedRawBytes
  if (size > BigInt(remaining)) throw new CurrentEvidenceError('hash-limit')
}

function enforceRawBytes(bytes: number, state: CaptureState): void {
  state.consumedRawBytes = checkedAdd(state.consumedRawBytes, bytes)
  if (bytes > state.bounds.maxFileBytes) throw new CurrentEvidenceError('file-limit')
  if (state.consumedRawBytes > state.bounds.maxTotalFileBytes) throw new CurrentEvidenceError('hash-limit')
}

function observeNestedGitBytes(state: CaptureState, bytes: number): void {
  state.gitOutputBytes = checkedAdd(state.gitOutputBytes, bytes)
  if (state.gitOutputBytes > state.bounds.maxGitOutputBytes) throw new RepositoryInventoryError('unavailable')
}

function resolveInventoryPath(root: string, bytes: Uint8Array): string {
  let value: string
  try {
    value = UTF8.decode(bytes)
  } catch {
    throw new CurrentEvidenceError('invalid-utf8')
  }
  if (isAbsolute(value) || !isSupportedInventoryPath(value, process.platform)) {
    throw new CurrentEvidenceError('unsupported-state')
  }
  const path = resolve(root, value)
  return path
}

/**
 * Test Git path text against ordinary directory-entry syntax for one Host platform.
 * @param value - decoded repository-relative Git path.
 * @param platform - Host path semantics used by the execution provider.
 * @returns whether the path can identify ordinary filesystem entries on that Host.
 */
export function isSupportedInventoryPath(value: string, platform: NodeJS.Platform): boolean {
  const components = value.split('/')
  return value !== ''
    && components.every(component => component !== '' && component !== '.' && component !== '..')
    && (platform !== 'win32' || (!value.includes('\\') && components.every(component => !component.includes(':'))))
}

async function resolveExistingAncestor(
  state: CaptureState,
  start: string,
): Promise<{
  readonly path: string
  readonly identity: string
  readonly entry: BigIntStats
  readonly target: BigIntStats
}> {
  let candidate = start
  while (true) {
    try {
      const entry = await state.facts.lstat(candidate)
      const identity = await state.facts.realpath(candidate)
      if (!containsPath(state.root, identity)) throw new CurrentEvidenceError('unsupported-state')
      const confirmedEntry = await state.facts.lstat(candidate)
      const target = await state.facts.lstat(identity)
      if (!sameStat(entry, confirmedEntry) || !target.isDirectory()) {
        throw new CurrentEvidenceError('unstable-content')
      }
      return { path: candidate, identity, entry: confirmedEntry, target }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || candidate === state.root) throw error
      candidate = dirname(candidate)
    }
  }
}

function containsPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function rememberIdentity(info: BigIntStats, state: CaptureState, transaction: IdentityTransaction): void {
  const identity = `${info.dev}:${info.ino}`
  if (state.identities.has(identity)) throw new CurrentEvidenceError('duplicate-path')
  state.identities.add(identity)
  transaction.added = identity
}

function sameStat(
  left: { dev: bigint; ino: bigint; size: bigint; mode: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: typeof left,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function executableMode(mode: bigint): '100644' | '100755' {
  return (mode & 0o100n) === 0n ? '100644' : '100755'
}

function gitBlobId(format: 'sha1' | 'sha256', bytes: Uint8Array): string {
  return createHash(format).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

function objectMatchesFormat(objectId: string, format: 'sha1' | 'sha256'): boolean {
  return /^[0-9a-f]+$/u.test(objectId) && objectId.length === (format === 'sha1' ? 40 : 64)
}

function pathKey(path: Uint8Array): string {
  return Buffer.from(path).toString('hex')
}

function splitNul(bytes: Uint8Array): Uint8Array[] {
  return splitNulFields(bytes, false)
}

function splitConfigNul(bytes: Uint8Array): Uint8Array[] {
  return splitNulFields(bytes, true)
}

function splitNulFields(bytes: Uint8Array, allowEmpty: boolean): Uint8Array[] {
  if (bytes.byteLength === 0) return []
  const values: Uint8Array[] = []
  let start = 0
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue
    if (!allowEmpty && index === start) throw new RepositoryInventoryError('malformed')
    values.push(bytes.subarray(start, index))
    start = index + 1
  }
  if (start !== bytes.byteLength) throw new RepositoryInventoryError('malformed')
  return values
}

function decode(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes)
  } catch {
    throw new RepositoryInventoryError('malformed')
  }
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum)) throw new RepositoryInventoryError('unavailable')
  return sum
}

function checkTime(state: CaptureState): void {
  state.signal.throwIfAborted()
  if (performance.now() - state.startedAt > state.bounds.maxCaptureMs) {
    throw new RepositoryInventoryError('unavailable')
  }
}
