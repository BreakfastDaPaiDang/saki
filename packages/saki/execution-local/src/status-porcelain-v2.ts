/**
 * Validates the fixed Local Host status command, decodes its branch headers,
 * and retains repository paths as owned raw bytes.
 * @module @breakfastdapaidang/saki-execution-local/status-porcelain-v2
 */

import { iterateNulFields, startsWithAscii } from './raw-git-output.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const MODE = /^(?:000000|040000|100644|100755|120000|160000)$/u

/** Parsed branch identity from the required porcelain v2 branch headers. */
export interface ParsedStatusBranch {
  readonly oid: { readonly kind: 'commit'; readonly objectId: string } | { readonly kind: 'initial' }
  readonly head: { readonly kind: 'attached'; readonly name: string } | { readonly kind: 'detached' }
  readonly upstream?: {
    readonly name: string
    readonly ahead?: number
    readonly behind?: number
  }
}

/** A tracked status code attributed to the index. */
export type ParsedIndexStatus = 'unchanged' | 'modified' | 'type-changed' | 'added' | 'deleted'

/** A tracked status code attributed to the worktree. */
export type ParsedWorktreeStatus = 'unchanged' | 'modified' | 'type-changed' | 'added' | 'deleted'

/** Explicit submodule state carried by one tracked porcelain entry. */
export type ParsedSubmoduleStatus =
  | { readonly kind: 'not-submodule' }
  | {
    readonly kind: 'submodule'
    readonly commitChanged: boolean | 'unknown'
    readonly trackedChanges: boolean
    readonly untrackedChanges: boolean
  }

/** One ordinary changed tracked entry. */
export interface ParsedOrdinaryStatusEntry {
  readonly kind: 'ordinary'
  readonly path: Uint8Array
  readonly indexStatus: ParsedIndexStatus
  readonly worktreeStatus: ParsedWorktreeStatus
  readonly submodule: ParsedSubmoduleStatus
  readonly head: { readonly mode: ParsedGitMode; readonly objectId: string }
  readonly index: { readonly mode: ParsedGitMode; readonly objectId: string }
  readonly worktreeMode: ParsedGitMode
}

/** One untracked worktree path absent from the index. */
export interface ParsedUntrackedStatusEntry {
  readonly kind: 'untracked'
  readonly path: Uint8Array
  readonly indexStatus: 'absent'
  readonly worktreeStatus: 'untracked'
  readonly submodule: { readonly kind: 'not-submodule' }
}

/** Conflict meaning encoded by an unmerged porcelain v2 XY pair. */
export type ParsedConflictStatus =
  | 'both-deleted'
  | 'added-by-us'
  | 'deleted-by-them'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'both-added'
  | 'both-modified'

/** One path whose index contains unmerged stages. */
export interface ParsedUnmergedStatusEntry {
  readonly kind: 'unmerged'
  readonly path: Uint8Array
  readonly indexStatus: 'unmerged'
  /** Presence derived from mW; the unresolved conflict remains an index fact. */
  readonly worktreeStatus: 'present' | 'absent'
  readonly conflict: ParsedConflictStatus
  readonly submodule: ParsedSubmoduleStatus
  readonly base: { readonly mode: ParsedGitMode; readonly objectId: string }
  readonly ours: { readonly mode: ParsedGitMode; readonly objectId: string }
  readonly theirs: { readonly mode: ParsedGitMode; readonly objectId: string }
  readonly worktreeMode: ParsedGitMode
}

/** One parsed porcelain v2 path entry. */
export type ParsedStatusEntry =
  | ParsedOrdinaryStatusEntry
  | ParsedUnmergedStatusEntry
  | ParsedUntrackedStatusEntry

/** Complete parsed result from one status command. */
export interface ParsedStatusPorcelainV2 {
  readonly branch: ParsedStatusBranch
  /** Observed object-name width, absent when no commit or path object exists. */
  readonly objectIdWidth?: 40 | 64
  readonly entries: readonly ParsedStatusEntry[]
}

/** File mode reported by porcelain v2, including an absent slot. */
export type ParsedGitMode = '000000' | '040000' | '100644' | '100755' | '120000' | '160000'

/**
 * Parse complete `git status --porcelain=v2 --branch -z --no-renames` output.
 * @param bytes - complete raw stdout from the fixed status command.
 * @returns branch facts and ordered entries whose path bytes are owned copies.
 * @throws When framing, headers, fixed fields, object evidence, or path identity is invalid or unsupported.
 */
export function parseStatusPorcelainV2(bytes: Uint8Array): ParsedStatusPorcelainV2 {
  let oid: ParsedStatusBranch['oid'] | undefined
  let head: ParsedStatusBranch['head'] | undefined
  let upstreamName: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  let objectIdWidth: 40 | 64 | undefined
  let pathsStarted = false
  const entries: ParsedStatusEntry[] = []
  const paths = new Set<string>()

  for (const field of iterateNulFields(bytes, 'Git status porcelain v2')) {
    if (field.length === 0) throw new Error('Git status porcelain v2 contains an empty record')
    if (startsWithAscii(field, '# ')) {
      if (pathsStarted) throw new Error('Git status porcelain v2 header follows path entries')
      const header = parseHeader(field)
      if (header.name === 'branch.oid') {
        if (oid !== undefined) throw new Error('Git status porcelain v2 contains a duplicate branch.oid header')
        const value = header.value
        if (value === '(initial)') oid = { kind: 'initial' }
        else {
          objectIdWidth = acceptObjectId(value, objectIdWidth, false)
          oid = { kind: 'commit', objectId: value }
        }
      } else if (header.name === 'branch.head') {
        if (head !== undefined) throw new Error('Git status porcelain v2 contains a duplicate branch.head header')
        const value = header.value
        head = value === '(detached)' ? { kind: 'detached' } : { kind: 'attached', name: value }
      } else if (header.name === 'branch.upstream') {
        if (upstreamName !== undefined) {
          throw new Error('Git status porcelain v2 contains a duplicate branch.upstream header')
        }
        upstreamName = header.value
      } else if (header.name === 'branch.ab') {
        if (ahead !== undefined || behind !== undefined) {
          throw new Error('Git status porcelain v2 contains a duplicate branch.ab header')
        }
        const value = header.value
        const match = /^\+(0|[1-9][0-9]*) -(0|[1-9][0-9]*)$/u.exec(value)
        if (match === null) throw new Error('Git status porcelain v2 has malformed branch.ab counts')
        ahead = Number(match[1])
        behind = Number(match[2])
        if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
          throw new Error('Git status porcelain v2 has invalid branch tracking counts')
        }
      }
      continue
    }

    pathsStarted = true
    if (startsWithAscii(field, '1 ')) {
      const { fixed, path } = splitFixedFields(field, 2, 7)
      const [xy, submodule, headMode, indexMode, worktreeMode, headObjectId, indexObjectId] = fixed as [
        string, string, string, string, string, string, string,
      ]
      if (xy.length !== 2 || xy === '..') {
        throw new Error('Git status porcelain v2 has an invalid ordinary status')
      }
      objectIdWidth = acceptObjectId(headObjectId, objectIdWidth, true)
      objectIdWidth = acceptObjectId(indexObjectId, objectIdWidth, true)
      const headSlot = parseObjectSlot(headMode, headObjectId)
      const indexSlot = parseObjectSlot(indexMode, indexObjectId)
      retainPath(path, paths)
      entries.push({
        kind: 'ordinary',
        path: path.slice(),
        indexStatus: parseIndexStatus(xy[0]),
        worktreeStatus: parseWorktreeStatus(xy[1]),
        submodule: parseSubmoduleStatus(submodule),
        head: headSlot,
        index: indexSlot,
        worktreeMode: parseMode(worktreeMode),
      })
    } else if (startsWithAscii(field, 'u ')) {
      const { fixed, path } = splitFixedFields(field, 2, 9)
      const [xy, submodule, baseMode, oursMode, theirsMode, worktreeMode, baseId, oursId, theirsId] = fixed as [
        string, string, string, string, string, string, string, string, string,
      ]
      objectIdWidth = acceptObjectId(baseId, objectIdWidth, true)
      objectIdWidth = acceptObjectId(oursId, objectIdWidth, true)
      objectIdWidth = acceptObjectId(theirsId, objectIdWidth, true)
      const baseSlot = parseObjectSlot(baseMode, baseId)
      const oursSlot = parseObjectSlot(oursMode, oursId)
      const theirsSlot = parseObjectSlot(theirsMode, theirsId)
      const parsedWorktreeMode = parseMode(worktreeMode)
      retainPath(path, paths)
      entries.push({
        kind: 'unmerged',
        path: path.slice(),
        indexStatus: 'unmerged',
        worktreeStatus: parsedWorktreeMode === '000000' ? 'absent' : 'present',
        conflict: parseConflictStatus(xy),
        submodule: parseSubmoduleStatus(submodule),
        base: baseSlot,
        ours: oursSlot,
        theirs: theirsSlot,
        worktreeMode: parsedWorktreeMode,
      })
    } else if (startsWithAscii(field, '? ')) {
      const path = field.subarray(2)
      if (path.length === 0) throw new Error('Git status porcelain v2 has an empty untracked path')
      retainPath(path, paths)
      entries.push({
        kind: 'untracked',
        path: path.slice(),
        indexStatus: 'absent',
        worktreeStatus: 'untracked',
        submodule: { kind: 'not-submodule' },
      })
    } else {
      throw new Error('Git status porcelain v2 contains an unsupported record')
    }
  }

  if (oid === undefined || head === undefined) {
    throw new Error('Git status porcelain v2 is missing required branch headers')
  }
  if (oid.kind === 'initial' && head.kind === 'detached') {
    throw new Error('Git status porcelain v2 has an inconsistent branch identity')
  }
  if ((ahead !== undefined || behind !== undefined)
    && (upstreamName === undefined || oid.kind !== 'commit' || head.kind !== 'attached')) {
    throw new Error('Git status porcelain v2 has inconsistent branch tracking counts')
  }
  if (upstreamName !== undefined && head.kind !== 'attached') {
    throw new Error('Git status porcelain v2 has inconsistent branch tracking state')
  }
  const upstream = upstreamName === undefined
    ? undefined
    : {
      name: upstreamName,
      ...(ahead === undefined ? {} : { ahead }),
      ...(behind === undefined ? {} : { behind }),
    }
  return {
    branch: { oid, head, ...(upstream === undefined ? {} : { upstream }) },
    ...(objectIdWidth === undefined ? {} : { objectIdWidth }),
    entries,
  }
}

function retainPath(path: Uint8Array, paths: Set<string>): void {
  const key = Buffer.from(path).toString('hex')
  if (paths.has(key)) throw new Error('Git status porcelain v2 contains a duplicate path')
  paths.add(key)
}

function parseConflictStatus(value: string): ParsedConflictStatus {
  switch (value) {
    case 'DD': return 'both-deleted'
    case 'AU': return 'added-by-us'
    case 'UD': return 'deleted-by-them'
    case 'UA': return 'added-by-them'
    case 'DU': return 'deleted-by-us'
    case 'AA': return 'both-added'
    case 'UU': return 'both-modified'
    default: throw new Error('Git status porcelain v2 has an invalid unmerged status')
  }
}

function parseIndexStatus(value: string | undefined): ParsedIndexStatus {
  switch (value) {
    case '.': return 'unchanged'
    case 'M': return 'modified'
    case 'T': return 'type-changed'
    case 'A': return 'added'
    case 'D': return 'deleted'
    default: throw new Error('Git status porcelain v2 has an invalid index status')
  }
}

function parseWorktreeStatus(value: string | undefined): ParsedWorktreeStatus {
  switch (value) {
    case '.': return 'unchanged'
    case 'M': return 'modified'
    case 'T': return 'type-changed'
    case 'A': return 'added'
    case 'D': return 'deleted'
    default: throw new Error('Git status porcelain v2 has an invalid worktree status')
  }
}

function parseSubmoduleStatus(value: string): ParsedSubmoduleStatus {
  if (value === 'N...') return { kind: 'not-submodule' }
  const match = /^S([C.])([M.])([U.])$/u.exec(value)
  if (match === null) throw new Error('Git status porcelain v2 has invalid submodule state')
  return {
    kind: 'submodule',
    commitChanged: match[1] === 'C',
    trackedChanges: match[2] === 'M',
    untrackedChanges: match[3] === 'U',
  }
}

function parseMode(value: string): ParsedGitMode {
  if (!MODE.test(value)) throw new Error('Git status porcelain v2 has an invalid file mode')
  return value as ParsedGitMode
}

function parseObjectSlot(
  modeValue: string,
  objectId: string,
): { readonly mode: ParsedGitMode; readonly objectId: string } {
  const mode = parseMode(modeValue)
  if ((mode === '000000') !== /^0+$/u.test(objectId)) {
    throw new Error('Git status porcelain v2 object slot mode and id disagree')
  }
  return { mode, objectId }
}

function acceptObjectId(
  value: string,
  acceptedWidth: 40 | 64 | undefined,
  allowZero: boolean,
): 40 | 64 {
  if (!OBJECT_ID.test(value) || (!allowZero && /^0+$/u.test(value))) {
    throw new Error('Git status porcelain v2 has an invalid object id')
  }
  const width = value.length as 40 | 64
  if (acceptedWidth !== undefined && acceptedWidth !== width) {
    throw new Error('Git status porcelain v2 mixes object id widths')
  }
  return width
}

function splitFixedFields(
  record: Uint8Array,
  offset: number,
  count: number,
): { readonly fixed: string[]; readonly path: Uint8Array } {
  const fixed: string[] = []
  let start = offset
  for (let index = 0; index < count; index += 1) {
    const space = record.indexOf(0x20, start)
    if (space <= start) throw new Error('Git status porcelain v2 tracked record is malformed')
    fixed.push(decodeAscii(record.subarray(start, space)))
    start = space + 1
  }
  const path = record.subarray(start)
  if (path.length === 0) throw new Error('Git status porcelain v2 has an empty tracked path')
  return { fixed, path }
}

function decodeHeader(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes)
  } catch (error) {
    throw new Error('Git status porcelain v2 header is not valid UTF-8', { cause: error })
  }
}

function parseHeader(bytes: Uint8Array): { readonly name: string; readonly value: string } {
  const header = decodeHeader(bytes)
  const separator = header.indexOf(' ', 2)
  if (!header.startsWith('# ') || separator <= 2 || separator === header.length - 1) {
    throw new Error('Git status porcelain v2 header is malformed')
  }
  const name = header.slice(2, separator)
  const value = header.slice(separator + 1)
  if (!/^[!-~]+$/u.test(name) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Git status porcelain v2 header is malformed')
  }
  return { name, value }
}

function decodeAscii(bytes: Uint8Array): string {
  if (bytes.some(byte => byte > 0x7f)) {
    throw new Error('Git status porcelain v2 fixed fields are not ASCII')
  }
  return String.fromCharCode(...bytes)
}
