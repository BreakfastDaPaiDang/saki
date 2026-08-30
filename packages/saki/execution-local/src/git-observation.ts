/** Raw-byte Git observation parsers used by the Local Host provider. @module @breakfastdapaidang/saki-execution-local/git-observation */

import { iterateNulFields, startsWithAscii } from './raw-git-output.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const TREE_MODE = /^(?:100644|100755|120000|160000)$/u
const INDEX_MODE = /^(?:040000|100644|100755|120000|160000)$/u

/** Conversion-related attributes recognized from complete attribute inventories. */
export const CONVERSION_ATTRIBUTES = [
  'filter', 'ident', 'text', 'eol', 'crlf', 'working-tree-encoding',
] as const

/** One exact-path object from `ls-tree`. */
export interface ParsedTreeEntry {
  readonly mode: '100644' | '100755' | '120000' | '160000'
  readonly objectId: string
  readonly path: Uint8Array
}

/** One exact-path tagged stage slot from the closed index inventory. */
export interface ParsedIndexEntry {
  readonly tag: 'H' | 'M' | 'S'
  readonly mode: '040000' | '100644' | '100755' | '120000' | '160000'
  readonly objectId: string
  readonly stage: 0 | 1 | 2 | 3
  readonly path: Uint8Array
}

/** Bounded conversion classes reduced from complete `check-attr` output. */
export interface ParsedCheckAttrConversion {
  readonly path: Uint8Array
  readonly executableFilter: boolean
  readonly unmodeled: boolean
  readonly lineEnding: boolean
}

/** Resource limits applied while raw membership records are parsed. */
export interface GitInventoryParseBounds {
  readonly maxEntries: number
  readonly maxPathBytes: number
}

/** Closed signal that a syntactically valid inventory exceeded parser limits. */
export class GitInventoryLimitError extends Error {}

/** Structurally validated facts from one `git worktree list --porcelain -z` record. */
export interface ParsedWorktreeRecord {
  /** Git-reported absolute worktree path before filesystem identity resolution. */
  readonly path: string
  /** Worktree HEAD, absent only for a bare record. */
  readonly head?: string
  /** Full branch ref for an attached worktree. */
  readonly branch?: string
  /** Whether Git reports a detached worktree. */
  readonly detached: boolean
  /** Bounded lock fact; provider text is discarded. */
  readonly locked: boolean
  /** Bounded prunable fact; provider text is discarded. */
  readonly prunable: boolean
  /** Whether the record represents a bare repository. */
  readonly bare: boolean
}

/**
 * Parse the complete recursive HEAD tree without decoding path bytes.
 * @param bytes - complete `ls-tree -r --full-tree -z HEAD` stdout.
 * @param bounds - distinct-path count and byte limits enforced before retention.
 * @returns validated blob and gitlink entries.
 */
export function parseLsTree(bytes: Uint8Array, bounds: GitInventoryParseBounds): ParsedTreeEntry[] {
  validateInventoryParseBounds(bounds)
  const entries: ParsedTreeEntry[] = []
  const paths = new Set<string>()
  let pathBytes = 0
  for (const field of iterateNulFields(bytes, 'Git output')) {
    if (field.length === 0) throw new Error('Git tree inventory contains an empty record')
    const tab = field.indexOf(0x09)
    if (tab <= 0 || tab === field.length - 1) throw new Error('Git tree inventory record is malformed')
    const fixed = decode(field.subarray(0, tab)).split(' ')
    if (fixed.length !== 3) throw new Error('Git tree inventory fixed fields are malformed')
    const [mode, type, objectId] = fixed as [string, string, string]
    if (!TREE_MODE.test(mode)
      || !OBJECT_ID.test(objectId)
      || /^0+$/u.test(objectId)
      || (mode === '160000' ? type !== 'commit' : type !== 'blob')) {
      throw new Error('Git tree inventory has invalid object evidence')
    }
    const path = field.subarray(tab + 1)
    if (path.byteLength > bounds.maxPathBytes) {
      throw new GitInventoryLimitError('Git tree inventory exceeds distinct-path limits')
    }
    const key = Buffer.from(path).toString('hex')
    if (paths.has(key)) throw new Error('Git tree inventory contains a duplicate path')
    pathBytes = retainDistinctPath(path, paths.size, pathBytes, bounds)
    paths.add(key)
    entries.push({ mode: mode as ParsedTreeEntry['mode'], objectId, path: path.slice() })
  }
  return entries
}

/**
 * Parse complete tagged index stage slots without decoding path bytes.
 * @param bytes - complete `ls-files --no-sparse -t --stage --full-name -z` stdout.
 * @param bounds - distinct-path count and byte limits enforced before retention.
 * @returns validated stage-zero, conflict-stage, and sparse-directory slots.
 */
export function parseLsFilesStage(bytes: Uint8Array, bounds: GitInventoryParseBounds): ParsedIndexEntry[] {
  validateInventoryParseBounds(bounds)
  const entries: ParsedIndexEntry[] = []
  const slots = new Set<string>()
  const stagesByPath = new Map<string, Set<number>>()
  const maxSlots = bounds.maxEntries * 3
  let pathBytes = 0
  for (const field of iterateNulFields(bytes, 'Git output')) {
    if (field.length === 0) throw new Error('Git index inventory contains an empty record')
    const tab = field.indexOf(0x09)
    if (tab <= 0 || tab === field.length - 1) throw new Error('Git index inventory record is malformed')
    const fixed = decode(field.subarray(0, tab)).split(' ')
    if (fixed.length !== 4) throw new Error('Git index inventory fixed fields are malformed')
    const [tag, mode, objectId, stageText] = fixed as [string, string, string, string]
    if (!/^[HMS]$/u.test(tag) || !INDEX_MODE.test(mode)
      || !OBJECT_ID.test(objectId) || !/^[0-3]$/u.test(stageText)) {
      throw new Error('Git index inventory has invalid stage evidence')
    }
    const stage = Number(stageText) as 0 | 1 | 2 | 3
    if ((stage === 0 && tag !== 'H' && tag !== 'S') || (stage !== 0 && tag !== 'M')) {
      throw new Error('Git index inventory tag disagrees with its stage')
    }
    if (/^0+$/u.test(objectId) || (stage !== 0 && mode === '040000')) {
      throw new Error('Git index inventory has unsupported stage evidence')
    }
    const path = field.subarray(tab + 1)
    if (path.byteLength > bounds.maxPathBytes) {
      throw new GitInventoryLimitError('Git index inventory exceeds parser limits')
    }
    const key = Buffer.from(path).toString('hex')
    const slot = `${key}:${stage}`
    if (slots.has(slot)) throw new Error('Git index inventory contains a duplicate stage slot')
    if (entries.length >= maxSlots) {
      throw new GitInventoryLimitError('Git index inventory exceeds parser limits')
    }
    const stages = stagesByPath.get(key) ?? new Set<number>()
    if ((stage === 0 && stages.size !== 0) || (stage !== 0 && stages.has(0))) {
      throw new Error('Git index inventory mixes stage zero with conflict stages')
    }
    if (!stagesByPath.has(key)) {
      pathBytes = retainDistinctPath(path, stagesByPath.size, pathBytes, bounds)
      stagesByPath.set(key, stages)
    }
    slots.add(slot)
    stages.add(stage)
    entries.push({
      tag: tag as ParsedIndexEntry['tag'],
      mode: mode as ParsedIndexEntry['mode'],
      objectId,
      stage,
      path: path.slice(),
    })
  }
  return entries
}

/**
 * Parse one complete NUL-framed list of exact Git path bytes.
 * @param bytes - complete NUL-framed path output.
 * @param bounds - distinct-path count and byte limits enforced before retention.
 * @returns unique non-empty path byte strings in Git order.
 */
export function parseNulPaths(bytes: Uint8Array, bounds: GitInventoryParseBounds): Uint8Array[] {
  validateInventoryParseBounds(bounds)
  const paths: Uint8Array[] = []
  const seen = new Set<string>()
  let pathBytes = 0
  for (const field of iterateNulFields(bytes, 'Git output')) {
    if (field.length === 0) throw new Error('Git path inventory contains an empty record')
    if (field.byteLength > bounds.maxPathBytes) {
      throw new GitInventoryLimitError('Git path inventory exceeds distinct-path limits')
    }
    const key = Buffer.from(field).toString('hex')
    if (seen.has(key)) throw new Error('Git path inventory contains a duplicate path')
    pathBytes = retainDistinctPath(field, seen.size, pathBytes, bounds)
    seen.add(key)
    paths.push(field.slice())
  }
  return paths
}

/**
 * Validate complete `check-attr --all -z --stdin` triplets and reduce
 * allowlisted attribute presence without retaining values or driver names.
 * @param bytes - complete NUL-framed attribute stdout.
 * @param paths - exact input paths in their submitted order.
 * @returns one conversion classification aligned to each submitted path.
 */
export function parseCheckAttrConversion(
  bytes: Uint8Array,
  paths: readonly Uint8Array[],
): ParsedCheckAttrConversion[] {
  const fields = splitNul(bytes)
  const triplets: [Uint8Array, Uint8Array, Uint8Array][] = []
  for (let offset = 0; offset < fields.length; offset += 3) {
    const reportedPath = fields[offset]
    const attribute = fields[offset + 1]
    const value = fields[offset + 2]
    if (reportedPath === undefined || attribute === undefined || value === undefined) {
      throw new Error('Git attribute output has incomplete triplets')
    }
    triplets.push([reportedPath, attribute, value])
  }
  const pathClassifications = new Map<string, {
    readonly result: {
      readonly path: Uint8Array
      executableFilter: boolean
      unmodeled: boolean
      lineEnding: boolean
    }
    readonly seen: Set<string>
  }>()
  const classifications = paths.map((path) => {
    const key = Buffer.from(path).toString('hex')
    if (path.length === 0 || pathClassifications.has(key)) {
      throw new Error('Git attribute input path inventory is malformed')
    }
    const result: ParsedCheckAttrConversion = {
      path: path.slice(), executableFilter: false, unmodeled: false, lineEnding: false,
    }
    pathClassifications.set(key, { result, seen: new Set() })
    return result
  })
  for (const [reportedPath, attributeBytes] of triplets) {
    const attribute = decode(attributeBytes)
    const classification = pathClassifications.get(Buffer.from(reportedPath).toString('hex'))
    if (classification === undefined) {
      throw new Error('Git attribute output does not match its requested path inventory')
    }
    if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/u.test(attribute)) {
      throw new Error('Git attribute output has an invalid attribute name')
    }
    const { result, seen } = classification
    if (seen.has(attribute)) throw new Error('Git attribute output contains a duplicate path attribute')
    seen.add(attribute)
    if (attribute === 'filter') result.executableFilter = true
    else if (attribute === 'ident' || attribute === 'working-tree-encoding') result.unmodeled = true
    else if (attribute === 'text' || attribute === 'eol' || attribute === 'crlf') result.lineEnding = true
  }
  return classifications
}

/**
 * Parse complete NUL-framed worktree porcelain without retaining extension,
 * lock-reason, or prune-reason text.
 * @param bytes - complete stdout from `git worktree list --porcelain -z`.
 * @returns one validated record per Git worktree record.
 */
export function parseWorktreeList(bytes: Uint8Array): ParsedWorktreeRecord[] {
  const fields = splitNul(bytes)
  const records: ParsedWorktreeRecord[] = []
  let current: MutableWorktree | undefined

  for (const field of fields) {
    if (field.length === 0) {
      if (current === undefined) throw new Error('Git worktree output contains an extra empty record')
      records.push(finishWorktree(current))
      current = undefined
      continue
    }
    if (startsWithAscii(field, 'worktree ')) {
      if (current !== undefined) throw new Error('Git worktree record has no NUL record terminator')
      const path = decode(field.subarray('worktree '.length))
      if (path === '') throw new Error('Git worktree record has an empty path')
      current = { path, detached: false, locked: false, prunable: false, bare: false }
      continue
    }
    if (current === undefined) throw new Error('Git worktree attribute appears before a worktree path')
    if (startsWithAscii(field, 'HEAD ')) {
      const head = decode(field.subarray('HEAD '.length))
      if (current.head !== undefined || !OBJECT_ID.test(head)) {
        throw new Error('Git worktree record has an invalid or duplicate HEAD')
      }
      current.head = head
    } else if (startsWithAscii(field, 'branch ')) {
      const branch = decode(field.subarray('branch '.length))
      if (current.branch !== undefined || current.detached || branch === '') {
        throw new Error('Git worktree record has an invalid or duplicate branch state')
      }
      current.branch = branch
    } else if (equalsAscii(field, 'detached')) {
      if (current.detached || current.branch !== undefined) {
        throw new Error('Git worktree record has duplicate branch state')
      }
      current.detached = true
    } else if (equalsAscii(field, 'bare')) {
      if (current.bare) throw new Error('Git worktree record has duplicate bare state')
      current.bare = true
    } else if (equalsAscii(field, 'locked') || startsWithAscii(field, 'locked ')) {
      if (current.locked) throw new Error('Git worktree record has duplicate locked state')
      current.locked = true
    } else if (equalsAscii(field, 'prunable') || startsWithAscii(field, 'prunable ')) {
      if (current.prunable) throw new Error('Git worktree record has duplicate prunable state')
      current.prunable = true
    } else if (!hasValidExtensionName(field)) {
      throw new Error('Git worktree record has a malformed extension attribute')
    }
  }

  if (current !== undefined) throw new Error('Git worktree output ends inside a record')
  if (records.length === 0) throw new Error('Git worktree output contains no records')
  return records
}

interface MutableWorktree {
  path: string
  head?: string
  branch?: string
  detached: boolean
  locked: boolean
  prunable: boolean
  bare: boolean
}

function finishWorktree(record: MutableWorktree): ParsedWorktreeRecord {
  if (record.bare) {
    if (record.head !== undefined || record.branch !== undefined || record.detached) {
      throw new Error('Git bare worktree record carries non-bare identity facts')
    }
  } else if (record.head === undefined || (record.branch === undefined) === !record.detached) {
    throw new Error('Git worktree record has incomplete identity facts')
  }
  return { ...record }
}

function splitNul(bytes: Uint8Array): Uint8Array[] {
  return [...iterateNulFields(bytes, 'Git output')]
}

function validateInventoryParseBounds(bounds: GitInventoryParseBounds): void {
  if (!Number.isSafeInteger(bounds.maxEntries) || bounds.maxEntries <= 0
    || bounds.maxEntries > Math.floor(Number.MAX_SAFE_INTEGER / 3)
    || !Number.isSafeInteger(bounds.maxPathBytes) || bounds.maxPathBytes <= 0) {
    throw new GitInventoryLimitError('Git inventory parser bounds are invalid')
  }
}

function retainDistinctPath(
  path: Uint8Array,
  retainedEntries: number,
  retainedPathBytes: number,
  bounds: GitInventoryParseBounds,
): number {
  if (retainedEntries >= bounds.maxEntries || path.byteLength > bounds.maxPathBytes - retainedPathBytes) {
    throw new GitInventoryLimitError('Git inventory exceeds distinct-path limits')
  }
  return retainedPathBytes + path.byteLength
}

function decode(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes)
  } catch (error) {
    throw new Error('Git output is not valid UTF-8', { cause: error })
  }
}

function equalsAscii(bytes: Uint8Array, value: string): boolean {
  return bytes.length === value.length && startsWithAscii(bytes, value)
}

function hasValidExtensionName(field: Uint8Array): boolean {
  const space = field.indexOf(0x20)
  const name = field.subarray(0, space === -1 ? field.length : space)
  const first = name[0]
  if (first === undefined || !asciiLetter(first)) return false
  return name.subarray(1).every(byte => asciiLetter(byte) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2e || byte === 0x2d)
}

function asciiLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
}
