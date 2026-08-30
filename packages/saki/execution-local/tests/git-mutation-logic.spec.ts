import { constants as bufferConstants } from 'node:buffer'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computeProjectGitChangeFingerprint,
  computeProjectGitChangeId,
  exactBytesDigest,
  projectGitChangeSchema,
  type ProjectGitChange,
  type ProjectGitChangeFingerprintMaterial,
  type ProjectGitChangeMaterial,
  type ProjectGitFileMode,
  type ProjectGitSubmoduleStatus,
  type ProjectGitWorktreeEvidence,
} from '@breakfastdapaidang/saki-execution'
import {
  addGitIndexInstructionBytes,
  addOwnedLooseObjectCount,
  classifyScratchMarkerConfirmation,
  classifyOwnedFileObservation,
  classifyGitMutationError,
  decideCancelIndexEvidenceFailure,
  decideCancelTargetReadFailure,
  decideGitIndexRecoveryReadFailure,
  decideGitIndexSelection,
  decideOwnedFileReadFailure,
  decideWorktreeSymlinkReadFailure,
  decideGitPublicationRecovery,
  formatGitTimezone,
  gitIndexInstructionByteLimit,
  groupLooseObjectIdsByFanout,
  localGitMutationNodeAdapter,
  nodePathMissing,
  NoEffectMutationError,
  parentDirectoryChain,
  parseCanonicalCommitIdentity,
  parseLocalGitConfigValue,
  parseGitObjectId,
  readExactWorktreeBytes,
  readExactWorktreeSymlinkBytes,
  rejectStableSelectionFailure,
  resolveBoundedReadOpenFlags,
  requireOwnedLooseObjectManifestObservation,
  requirePreparedMutationActive,
  resolveCommitRefPath,
  resolveCommitReflogPath,
  RetryableMutationError,
  type OwnedLooseObjectManifestObservation,
} from '../src/git-mutation.ts'
import { GitCommandError } from '../src/git-runner.ts'
import type { CapturedInventoryGitObject, CapturedRepositoryInventoryEntry } from '../src/baseline.ts'

const INDEX_A = { kind: 'file', digest: 'a'.repeat(64), byteLength: 12, mode: 0o644 } as const
const INDEX_B = { kind: 'file', digest: 'b'.repeat(64), byteLength: 12, mode: 0o644 } as const
const INDEX_C = { kind: 'file', digest: 'c'.repeat(64), byteLength: 12, mode: 0o644 } as const
const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)
const ZERO_COMMIT = '0'.repeat(40)
const ABORT_REASON = new Error('stopped')
const UNEXPECTED_ERROR = new Error('unexpected')
const NODE_ERRNO = Object.assign(new Error('disk unavailable'), {
  code: 'EIO',
  errno: -5,
  syscall: 'read',
})
const CODED_PROGRAM_ERROR = Object.assign(new TypeError('invalid argument'), {
  code: 'ERR_INVALID_ARG_TYPE',
})
const DUCK_SYSTEM_ERROR = { code: 'EIO', errno: -5, syscall: 'read' }
const INCOMPLETE_SYSTEM_ERROR = Object.assign(new Error('incomplete system error'), {
  code: 'EIO',
  errno: -5,
})
const OBJECT_A = 'a'.repeat(40)
const OBJECT_B = 'b'.repeat(40)
const SHA256_OBJECT = 'c'.repeat(64)
const ZERO_OBJECT = '0'.repeat(40)
const STATUS_SEED_DIGEST = '3'.repeat(64)
const FILE_A = { mode: '100644', objectId: OBJECT_A } as const
const FILE_B = { mode: '100644', objectId: OBJECT_B } as const
const GITLINK_A = { mode: '160000', objectId: OBJECT_A } as const
const REGULAR_ENTRY = {
  path: Buffer.from('file.txt'),
  head: FILE_A,
  index: FILE_A,
  stages: [undefined, undefined, undefined],
  untracked: false,
  current: {
    kind: 'captured',
    evidence: { kind: 'regular', mode: '100644', byteLength: 4, contentDigest: 'f'.repeat(64) },
    rawObjectId: OBJECT_B,
    rawByteLength: 4,
    gitEvidenceBytes: 4,
  },
  conversion: { executableFilter: false, unmodeled: false, lineEnding: false },
} as const satisfies CapturedRepositoryInventoryEntry
const STAGED_ENTRY = {
  ...REGULAR_ENTRY,
  index: FILE_B,
} as const satisfies CapturedRepositoryInventoryEntry
const MISSING_ENTRY = {
  ...REGULAR_ENTRY,
  current: {
    kind: 'captured',
    evidence: { kind: 'missing' },
    rawByteLength: 0,
    gitEvidenceBytes: 0,
  },
} as const satisfies CapturedRepositoryInventoryEntry
const SUBMODULE_ENTRY = {
  ...REGULAR_ENTRY,
  head: GITLINK_A,
  index: GITLINK_A,
  current: {
    kind: 'captured',
    evidence: { kind: 'submodule', objectId: OBJECT_B },
    rawObjectId: OBJECT_B,
    rawByteLength: 0,
    gitEvidenceBytes: 0,
  },
} as const satisfies CapturedRepositoryInventoryEntry
const SYMLINK_ENTRY = {
  ...REGULAR_ENTRY,
  path: Buffer.from('link'),
  current: {
    kind: 'captured',
    evidence: { kind: 'symlink', targetDigest: 'e'.repeat(64) },
    rawObjectId: OBJECT_B,
    rawByteLength: 9,
    gitEvidenceBytes: 0,
  },
} as const satisfies CapturedRepositoryInventoryEntry
const UNAVAILABLE_ENTRY = {
  ...REGULAR_ENTRY,
  current: { kind: 'unavailable', reason: 'io-failure' },
} as const satisfies CapturedRepositoryInventoryEntry
const REGULAR_WITHOUT_OBJECT_ENTRY = {
  ...REGULAR_ENTRY,
  current: {
    kind: 'captured',
    evidence: REGULAR_ENTRY.current.evidence,
    rawByteLength: REGULAR_ENTRY.current.rawByteLength,
    gitEvidenceBytes: REGULAR_ENTRY.current.gitEvidenceBytes,
  },
} as const satisfies CapturedRepositoryInventoryEntry
const UNTRACKED_ENTRY = {
  path: Buffer.from('new.txt'),
  stages: [undefined, undefined, undefined],
  untracked: true,
  current: REGULAR_ENTRY.current,
  conversion: REGULAR_ENTRY.conversion,
} as const satisfies CapturedRepositoryInventoryEntry
const INDEX_ONLY_ENTRY = {
  path: Buffer.from('added.txt'),
  index: FILE_B,
  stages: [undefined, undefined, undefined],
  untracked: false,
  current: REGULAR_ENTRY.current,
  conversion: REGULAR_ENTRY.conversion,
} as const satisfies CapturedRepositoryInventoryEntry
const SELECTION_FIXTURES = {
  executableFilter: projectSelectionFixture({
    ...REGULAR_ENTRY,
    conversion: { ...REGULAR_ENTRY.conversion, executableFilter: true },
  }),
  unstaged: projectSelectionFixture(REGULAR_ENTRY),
  staged: projectSelectionFixture(STAGED_ENTRY),
  missing: projectSelectionFixture(MISSING_ENTRY),
  submodule: projectSelectionFixture(SUBMODULE_ENTRY),
  symlink: projectSelectionFixture(SYMLINK_ENTRY),
  unavailable: projectSelectionFixture(UNAVAILABLE_ENTRY),
  missingObjectId: projectSelectionFixture(REGULAR_WITHOUT_OBJECT_ENTRY),
  untracked: projectSelectionFixture(UNTRACKED_ENTRY),
  indexOnly: projectSelectionFixture(INDEX_ONLY_ENTRY),
} as const
const OWNED_FILE_EVIDENCE = {
  path: 'index.pin',
  digest: '1'.repeat(64),
  byteLength: 12,
  identity: { device: '7', inode: '9' },
  mode: 0o640,
} as const
const OWNED_FILE_STAT = {
  device: '7',
  inode: '9',
  byteLength: 12n,
  mode: 0o640,
  kind: 'file',
  modifiedNanoseconds: 30n,
  changedNanoseconds: 40n,
} as const

function projectSelectionFixture(entry: CapturedRepositoryInventoryEntry): {
  readonly change: ProjectGitChange
  readonly entry: CapturedRepositoryInventoryEntry
} {
  const path = new TextDecoder('utf-8', { fatal: true }).decode(entry.path)
  const worktreeEvidence = projectSelectionWorktreeEvidence(entry)
  if (entry.untracked) {
    const worktreeMode = worktreeEvidence.kind === 'unavailable'
      ? 'unknown'
      : worktreeEvidence.kind === 'regular'
        ? worktreeEvidence.mode
        : worktreeEvidence.kind === 'symlink'
          ? '120000'
          : undefined
    if (worktreeMode === undefined) throw new Error('test untracked fixture has impossible current evidence')
    return {
      entry,
      change: finalizeSelectionChange({
        path,
        attribution: 'not-inherited',
        kind: 'untracked',
        indexStatus: 'absent',
        worktreeStatus: 'untracked',
        submodule: { kind: 'not-submodule' },
        worktreeMode,
        worktreeEvidence,
      }),
    }
  }
  if (entry.stages.some(stage => stage !== undefined)) {
    throw new Error('test selection fixture unexpectedly contains unmerged stages')
  }
  const head = projectSelectionSlot(entry.head)
  const index = projectSelectionSlot(entry.index)
  const worktreeMode = projectSelectionWorktreeMode(entry)
  return {
    entry,
    change: finalizeSelectionChange({
      path,
      attribution: 'not-inherited',
      kind: 'ordinary',
      indexStatus: projectSelectionIndexStatus(entry),
      worktreeStatus: projectSelectionWorktreeStatus(entry, worktreeMode),
      submodule: projectSelectionSubmodule(entry),
      head,
      index,
      worktreeMode,
      worktreeEvidence,
    }),
  }
}

function finalizeSelectionChange(material: ProjectGitChangeFingerprintMaterial): ProjectGitChange {
  const change: ProjectGitChangeMaterial = {
    ...material,
    fingerprint: computeProjectGitChangeFingerprint(material),
  }
  return projectGitChangeSchema.parse({
    id: computeProjectGitChangeId(STATUS_SEED_DIGEST, change),
    ...change,
  })
}

function projectSelectionWorktreeEvidence(
  entry: CapturedRepositoryInventoryEntry,
): ProjectGitWorktreeEvidence {
  return entry.current.kind === 'captured'
    ? entry.current.evidence
    : { kind: 'unavailable', reason: entry.current.reason }
}

function projectSelectionSlot(slot: CapturedInventoryGitObject | undefined): {
  readonly mode: ProjectGitFileMode
  readonly objectId: string
} {
  return slot ?? { mode: '000000', objectId: ZERO_OBJECT }
}

function projectSelectionIndexStatus(
  entry: CapturedRepositoryInventoryEntry,
): Extract<ProjectGitChange, { readonly kind: 'ordinary' }>['indexStatus'] {
  if (entry.head === undefined) return 'added'
  if (entry.index === undefined) return 'deleted'
  if (selectionModeKind(entry.head.mode) !== selectionModeKind(entry.index.mode)) return 'type-changed'
  return entry.head.mode === entry.index.mode && entry.head.objectId === entry.index.objectId
    ? 'unchanged'
    : 'modified'
}

function projectSelectionWorktreeMode(entry: CapturedRepositoryInventoryEntry): ProjectGitFileMode {
  if (entry.current.kind === 'unavailable') return entry.index?.mode ?? '100644'
  switch (entry.current.evidence.kind) {
    case 'missing': return '000000'
    case 'regular': return entry.current.evidence.mode
    case 'symlink': return '120000'
    case 'submodule': return '160000'
  }
}

function projectSelectionWorktreeStatus(
  entry: CapturedRepositoryInventoryEntry,
  worktreeMode: ProjectGitFileMode,
): Extract<ProjectGitChange, { readonly kind: 'ordinary' }>['worktreeStatus'] {
  if (entry.current.kind === 'unavailable') return 'modified'
  if (entry.current.evidence.kind === 'missing') return entry.index === undefined ? 'unchanged' : 'deleted'
  if (entry.index === undefined) return 'added'
  if (selectionModeKind(entry.index.mode) !== selectionModeKind(worktreeMode)) return 'type-changed'
  return entry.current.rawObjectId === entry.index.objectId
      && (entry.current.evidence.kind !== 'regular' || entry.current.evidence.mode === entry.index.mode)
    ? 'unchanged'
    : 'modified'
}

function projectSelectionSubmodule(entry: CapturedRepositoryInventoryEntry): ProjectGitSubmoduleStatus {
  const gitlink = entry.head?.mode === '160000' || entry.index?.mode === '160000'
    || (entry.current.kind === 'captured' && entry.current.evidence.kind === 'submodule')
  if (!gitlink) return { kind: 'not-submodule' }
  const commit = entry.index?.mode === '160000'
      && entry.current.kind === 'captured' && entry.current.evidence.kind === 'submodule'
    ? entry.index.objectId === entry.current.evidence.objectId ? 'unchanged' : 'changed'
    : 'unknown'
  return { kind: 'submodule', commit }
}

function selectionModeKind(mode: ProjectGitFileMode): 'missing' | 'regular' | 'symlink' | 'submodule' {
  if (mode === '000000') return 'missing'
  if (mode === '120000') return 'symlink'
  if (mode === '160000') return 'submodule'
  return 'regular'
}

describe('Git mutation decisions', () => {
  it.each([
    {
      name: 'retains every supported POSIX safety flag',
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20_000, O_NONBLOCK: 0x800 },
      expected: 0x20_800,
    },
    {
      name: 'uses only O_RDONLY when optional flags are absent',
      constants: { O_RDONLY: 0 },
      expected: 0,
    },
  ])('$name', ({ constants, expected }) => {
    expect(resolveBoundedReadOpenFlags(constants)).toBe(expected)
  })

  it.each([
    {
      name: 'preserves caller cancellation above a readlink failure',
      error: NODE_ERRNO,
      interruption: { aborted: true, reason: ABORT_REASON },
      expected: { kind: 'aborted', reason: ABORT_REASON },
    },
    {
      name: 'maps a Node readlink failure to retryable unavailability',
      error: NODE_ERRNO,
      interruption: { aborted: false, reason: undefined },
      expected: { kind: 'retryable', reason: 'unavailable' },
    },
    {
      name: 'preserves a plain program failure',
      error: UNEXPECTED_ERROR,
      interruption: { aborted: false, reason: undefined },
      expected: { kind: 'unexpected', error: UNEXPECTED_ERROR },
    },
    {
      name: 'preserves an incomplete system-shaped Error',
      error: INCOMPLETE_SYSTEM_ERROR,
      interruption: { aborted: false, reason: undefined },
      expected: { kind: 'unexpected', error: INCOMPLETE_SYSTEM_ERROR },
    },
    {
      name: 'preserves a duck-typed system value',
      error: DUCK_SYSTEM_ERROR,
      interruption: { aborted: false, reason: undefined },
      expected: { kind: 'unexpected', error: DUCK_SYSTEM_ERROR },
    },
  ] as const)('$name', ({ error, interruption, expected }) => {
    expect(decideWorktreeSymlinkReadFailure(error, interruption)).toEqual(expected)
  })

  it.each(['ENOENT', 'EINVAL', 'EIO'] as const)(
    'maps a real %s readlink rejection through the exact symlink leaf',
    async (code) => {
      const failure = Object.assign(new Error(`readlink failed with ${code}`), {
        code,
        errno: -1,
        syscall: 'readlink',
      })
      await expect(readExactWorktreeSymlinkBytes(
        { readlink: async () => { throw failure } },
        '/worktree/link',
        '0'.repeat(64),
        new AbortController().signal,
      )).rejects.toMatchObject({ reason: 'unavailable' })
    },
  )

  it('preserves an abort raised with a failing exact symlink read', async () => {
    const controller = new AbortController()
    const reason = new Error('stopped during readlink failure')
    const failure = Object.assign(new Error('readlink unavailable'), {
      code: 'EIO',
      errno: -5,
      syscall: 'readlink',
    })
    await expect(readExactWorktreeSymlinkBytes(
      {
        async readlink() {
          controller.abort(reason)
          throw failure
        },
      },
      '/worktree/link',
      '0'.repeat(64),
      controller.signal,
    )).rejects.toBe(reason)
  })

  it('does not start an exact symlink read after caller cancellation', async () => {
    const controller = new AbortController()
    const reason = new Error('stopped before readlink')
    let reads = 0
    controller.abort(reason)
    await expect(readExactWorktreeSymlinkBytes(
      {
        async readlink() {
          reads += 1
          return Buffer.from('unreachable', 'utf8')
        },
      },
      '/worktree/link',
      '0'.repeat(64),
      controller.signal,
    )).rejects.toBe(reason)
    expect(reads).toBe(0)
  })

  it('preserves a plain exact symlink read failure', async () => {
    const failure = new Error('readlink program failure')
    await expect(readExactWorktreeSymlinkBytes(
      { readlink: async () => { throw failure } },
      '/worktree/link',
      '0'.repeat(64),
      new AbortController().signal,
    )).rejects.toBe(failure)
  })

  it('preserves an abort raised by a successful exact symlink read', async () => {
    const controller = new AbortController()
    const reason = new Error('stopped after readlink')
    const bytes = Buffer.from('target-bytes', 'utf8')
    await expect(readExactWorktreeSymlinkBytes(
      {
        async readlink() {
          controller.abort(reason)
          return bytes
        },
      },
      '/worktree/link',
      exactBytesDigest('saki/inherited-symlink/v1', bytes),
      controller.signal,
    )).rejects.toBe(reason)
  })

  it('returns the adapter Buffer when exact symlink target evidence matches', async () => {
    const bytes = Buffer.from('../target-file', 'utf8')
    await expect(readExactWorktreeSymlinkBytes(
      { readlink: async () => bytes },
      '/worktree/link',
      exactBytesDigest('saki/inherited-symlink/v1', bytes),
      new AbortController().signal,
    )).resolves.toBe(bytes)
  })

  it('reads real symbolic-link bytes through the production Node adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-git-mutation-symlink-'))
    try {
      const target = join(root, 'target')
      const link = join(root, 'link')
      await mkdir(target)
      await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      const targetBytes = await localGitMutationNodeAdapter.readlink(link)
      await expect(readExactWorktreeBytes(
        localGitMutationNodeAdapter,
        root,
        'link',
        {
          kind: 'symlink',
          targetDigest: exactBytesDigest('saki/inherited-symlink/v1', targetBytes),
        },
        new AbortController().signal,
      )).resolves.toEqual(targetBytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects exact symlink target drift before its bytes reach Git', async () => {
    const bytes = Buffer.from('../changed-target', 'utf8')
    await expect(readExactWorktreeSymlinkBytes(
      { readlink: async () => bytes },
      '/worktree/link',
      exactBytesDigest('saki/inherited-symlink/v1', Buffer.from('../expected-target', 'utf8')),
      new AbortController().signal,
    )).rejects.toMatchObject({ reason: 'observation-stale' })
  })

  it('accepts the exact Buffer limit and rejects one byte beyond it', () => {
    expect(addGitIndexInstructionBytes(bufferConstants.MAX_LENGTH - 60, 60))
      .toBe(bufferConstants.MAX_LENGTH)
    expect(addGitIndexInstructionBytes(bufferConstants.MAX_LENGTH - 60, 61)).toBeUndefined()
  })

  it('accepts the exact safe object-count limit and rejects one beyond it', () => {
    expect(addOwnedLooseObjectCount(Number.MAX_SAFE_INTEGER - 60, 60))
      .toBe(Number.MAX_SAFE_INTEGER)
    expect(addOwnedLooseObjectCount(Number.MAX_SAFE_INTEGER - 60, 61)).toBeUndefined()
  })

  it('keeps active prepared mutations without discarding private artifacts', async () => {
    let discarded = false
    await requirePreparedMutationActive(
      new AbortController().signal,
      async () => { discarded = true },
    )
    expect(discarded).toBe(false)
  })

  it('discards private preparation before preserving the exact abort reason', async () => {
    const controller = new AbortController()
    const reason = new Error('stopped after private preparation')
    const events: string[] = []
    controller.abort(reason)
    await expect(requirePreparedMutationActive(controller.signal, async () => {
      events.push('discarded')
    })).rejects.toBe(reason)
    expect(events).toEqual(['discarded'])
  })

  it.each([
    { maxPathBytes: 11, changeCount: 1, objectIdWidth: 40, expected: 60 },
    { maxPathBytes: 11, changeCount: 1, objectIdWidth: 64, expected: 84 },
    { maxPathBytes: 2, changeCount: 2, objectIdWidth: 40, expected: 100 },
    {
      maxPathBytes: bufferConstants.MAX_LENGTH,
      changeCount: 100_000,
      objectIdWidth: 64,
      expected: bufferConstants.MAX_LENGTH,
    },
  ] as const)(
    'bounds $changeCount sha-$objectIdWidth update-index records at $expected bytes',
    ({ maxPathBytes, changeCount, objectIdWidth, expected }) => {
      expect(gitIndexInstructionByteLimit(maxPathBytes, changeCount, objectIdWidth)).toBe(expected)
    },
  )

  it.each([
    {
      name: 'preserves caller cancellation above an owned-file read failure',
      error: NODE_ERRNO,
      interruption: { aborted: true, reason: ABORT_REASON },
      expected: { kind: 'aborted', reason: ABORT_REASON },
    },
    {
      name: 'classifies a missing owned-file path',
      error: Object.assign(new Error('owned file is missing'), {
        code: 'ENOENT',
        errno: -4_058,
        syscall: 'lstat',
        path: 'index.lock',
      }),
      interruption: { aborted: false, reason: undefined },
      expected: { kind: 'state', state: 'missing' },
    },
    {
      name: 'classifies an owned-file system failure as unavailable',
      error: NODE_ERRNO,
      interruption: { aborted: false, reason: undefined },
      expected: { kind: 'state', state: 'unavailable' },
    },
    {
      name: 'classifies an unknown owned-file failure as unavailable',
      error: UNEXPECTED_ERROR,
      interruption: { aborted: false, reason: undefined },
      expected: { kind: 'state', state: 'unavailable' },
    },
  ] as const)('$name', ({ error, interruption, expected }) => {
    expect(decideOwnedFileReadFailure(error, interruption)).toEqual(expected)
  })

  it.each([
    {
      name: 'accepts an unchanged scratch marker confirmation',
      confirmed: OWNED_FILE_STAT,
      digestMatches: true,
      markerMatches: true,
      expected: 'owned',
    },
    {
      name: 'rejects a scratch marker device change',
      confirmed: { ...OWNED_FILE_STAT, device: '8' },
      digestMatches: true,
      markerMatches: true,
      expected: 'foreign',
    },
    {
      name: 'rejects a scratch marker inode change',
      confirmed: { ...OWNED_FILE_STAT, inode: '10' },
      digestMatches: true,
      markerMatches: true,
      expected: 'foreign',
    },
    {
      name: 'rejects a scratch marker length change',
      confirmed: { ...OWNED_FILE_STAT, byteLength: 13n },
      digestMatches: true,
      markerMatches: true,
      expected: 'foreign',
    },
    {
      name: 'rejects a scratch marker modification-time change',
      confirmed: { ...OWNED_FILE_STAT, modifiedNanoseconds: 31n },
      digestMatches: true,
      markerMatches: true,
      expected: 'foreign',
    },
    {
      name: 'rejects a scratch marker change-time change',
      confirmed: { ...OWNED_FILE_STAT, changedNanoseconds: 41n },
      digestMatches: true,
      markerMatches: true,
      expected: 'foreign',
    },
    {
      name: 'rejects a scratch marker digest mismatch',
      confirmed: OWNED_FILE_STAT,
      digestMatches: false,
      markerMatches: true,
      expected: 'foreign',
    },
    {
      name: 'rejects a scratch marker byte mismatch',
      confirmed: OWNED_FILE_STAT,
      digestMatches: true,
      markerMatches: false,
      expected: 'foreign',
    },
  ] as const)('$name', ({ confirmed, digestMatches, markerMatches, expected }) => {
    expect(classifyScratchMarkerConfirmation({
      before: OWNED_FILE_STAT,
      confirmed,
      digestMatches,
      markerMatches,
    })).toBe(expected)
  })

  it.each([
    { name: 'parses LF', stdout: Buffer.from('Saki Test\n', 'utf8') },
    { name: 'parses CRLF', stdout: Buffer.from('Saki Test\r\n', 'utf8') },
  ] as const)('$name in one repository-local Git config value', ({ stdout }) => {
    expect(parseLocalGitConfigValue(stdout, Buffer.alloc(0))).toBe('Saki Test')
  })

  it.each([
    {
      name: 'rejects nonempty standard error',
      stdout: Buffer.from('Saki Test\n', 'utf8'),
      stderr: Buffer.from('unexpected stderr\n', 'utf8'),
      expected: 'stream-failure',
    },
    {
      name: 'rejects fatal UTF-8',
      stdout: Buffer.from([0xc3, 0x28]),
      stderr: Buffer.alloc(0),
      expected: 'unsupported-state',
    },
    {
      name: 'rejects empty output',
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      expected: 'unsupported-state',
    },
    {
      name: 'rejects output without a newline',
      stdout: Buffer.from('Saki Test', 'utf8'),
      stderr: Buffer.alloc(0),
      expected: 'unsupported-state',
    },
    {
      name: 'rejects multiline output',
      stdout: Buffer.from('Saki Test\nOther Value\n', 'utf8'),
      stderr: Buffer.alloc(0),
      expected: 'unsupported-state',
    },
  ] as const)('$name from repository-local Git config', ({ stdout, stderr, expected }) => {
    let thrown: unknown
    try {
      parseLocalGitConfigValue(stdout, stderr)
    } catch (error) {
      thrown = error
    }
    if (expected === 'stream-failure') {
      expect(thrown).toBeInstanceOf(GitCommandError)
      expect(thrown).toMatchObject({ code: expected })
    } else {
      expect(thrown).toBeInstanceOf(NoEffectMutationError)
      expect(thrown).toMatchObject({ reason: expected })
    }
  })

  it.each([
    { name: 'LF', ending: '\n' },
    { name: 'CRLF', ending: '\r\n' },
  ] as const)('parses one canonical Git identity with $name', ({ ending }) => {
    expect(parseCanonicalCommitIdentity(
      Buffer.from(`Alice <saki@example.invalid> 1700000000 +0530${ending}`, 'utf8'),
      Buffer.alloc(0),
      1_700_000_000,
      '+0530',
    )).toEqual({
      name: 'Alice',
      email: 'saki@example.invalid',
      timestamp: 1_700_000_000,
      timezone: '+0530',
      source: 'git-config',
    })
  })

  it.each([
    {
      name: 'nonempty standard error',
      stdout: Buffer.from('Alice <saki@example.invalid> 1700000000 +0000\n'),
      stderr: Buffer.from('warning\n'),
      expected: GitCommandError,
    },
    {
      name: 'invalid UTF-8',
      stdout: Buffer.from([0xff]),
      stderr: Buffer.alloc(0),
      expected: NoEffectMutationError,
    },
    {
      name: 'empty canonical name',
      stdout: Buffer.from(' <saki@example.invalid> 1700000000 +0000\n'),
      stderr: Buffer.alloc(0),
      expected: NoEffectMutationError,
    },
    {
      name: 'empty canonical email',
      stdout: Buffer.from('Alice <> 1700000000 +0000\n'),
      stderr: Buffer.alloc(0),
      expected: NoEffectMutationError,
    },
    {
      name: 'different timestamp',
      stdout: Buffer.from('Alice <saki@example.invalid> 1700000001 +0000\n'),
      stderr: Buffer.alloc(0),
      expected: NoEffectMutationError,
    },
    {
      name: 'different timezone',
      stdout: Buffer.from('Alice <saki@example.invalid> 1700000000 +0001\n'),
      stderr: Buffer.alloc(0),
      expected: NoEffectMutationError,
    },
    {
      name: 'extra output record',
      stdout: Buffer.from('Alice <saki@example.invalid> 1700000000 +0000\nextra\n'),
      stderr: Buffer.alloc(0),
      expected: NoEffectMutationError,
    },
  ] as const)('rejects canonical Git identity with $name', ({ stdout, stderr, expected }) => {
    expect(() => parseCanonicalCommitIdentity(stdout, stderr, 1_700_000_000, '+0000')).toThrow(expected)
  })

  it.each([
    { reason: 'unsupported-index-state', errorType: 'no-effect', expectedReason: 'unsupported-state' },
    { reason: 'missing', errorType: 'no-effect', expectedReason: 'binding-stale' },
    { reason: 'not-directory', errorType: 'no-effect', expectedReason: 'binding-stale' },
    { reason: 'not-git', errorType: 'no-effect', expectedReason: 'binding-stale' },
    { reason: 'bare', errorType: 'no-effect', expectedReason: 'binding-stale' },
    { reason: 'prunable', errorType: 'no-effect', expectedReason: 'binding-stale' },
    { reason: 'ambiguous', errorType: 'retryable', expectedReason: 'unavailable' },
    { reason: 'malformed', errorType: 'retryable', expectedReason: 'unavailable' },
    { reason: 'unavailable', errorType: 'retryable', expectedReason: 'unavailable' },
    { reason: 'limit', errorType: 'retryable', expectedReason: 'unavailable' },
  ] as const)(
    'rejects stable selection failure $reason as $expectedReason',
    ({ reason, errorType, expectedReason }) => {
      let thrown: unknown
      try {
        rejectStableSelectionFailure(reason)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(errorType === 'no-effect' ? NoEffectMutationError : RetryableMutationError)
      expect(thrown).toMatchObject({ reason: expectedReason })
    },
  )

  it.each([
    { name: 'formats an eastward offset', offsetMinutes: 330, expected: '+0530' },
    { name: 'formats a westward offset', offsetMinutes: -480, expected: '-0800' },
    { name: 'formats UTC without a negative zero', offsetMinutes: 0, expected: '+0000' },
  ] as const)('$name', ({ offsetMinutes, expected }) => {
    expect(formatGitTimezone(offsetMinutes)).toBe(expected)
  })

  it.each([
    { name: 'rejects a non-safe integer offset', offsetMinutes: Number.MAX_SAFE_INTEGER + 1 },
    { name: 'rejects an offset beyond fourteen hours', offsetMinutes: 15 * 60 },
  ] as const)('$name', ({ offsetMinutes }) => {
    expect(() => formatGitTimezone(offsetMinutes)).toThrow(NoEffectMutationError)
  })

  const canonicalGitDirectory = resolve('repository', '.git', 'worktrees', 'linked')
  const canonicalCommonGitDirectory = resolve('repository', '.git')

  it.each([
    {
      name: 'resolves HEAD in the worktree Git directory',
      targetRef: 'HEAD',
      expected: join(canonicalGitDirectory, 'logs', 'HEAD'),
    },
    {
      name: 'resolves a safe ref in the common Git directory',
      targetRef: 'refs/heads/main',
      expected: resolve(canonicalCommonGitDirectory, 'logs', 'refs', 'heads', 'main'),
    },
  ] as const)('$name', ({ targetRef, expected }) => {
    expect(resolveCommitReflogPath(
      canonicalGitDirectory,
      canonicalCommonGitDirectory,
      targetRef,
    )).toBe(expected)
  })

  it.each([
    { name: 'rejects an empty reflog target', targetRef: '' },
    { name: 'rejects a traversing reflog target', targetRef: join('..', 'outside') },
    { name: 'rejects an absolute reflog target', targetRef: resolve('outside') },
  ] as const)('$name', ({ targetRef }) => {
    expect(() => resolveCommitReflogPath(
      canonicalGitDirectory,
      canonicalCommonGitDirectory,
      targetRef,
    )).toThrow('unsafe durable Commit reflog target')
  })

  it.each([
    {
      name: 'resolves HEAD in the worktree Git directory',
      targetRef: 'HEAD',
      expected: join(canonicalGitDirectory, 'HEAD'),
    },
    {
      name: 'resolves a safe ref in the common Git directory',
      targetRef: 'refs/heads/main',
      expected: resolve(canonicalCommonGitDirectory, 'refs', 'heads', 'main'),
    },
  ] as const)('$name for durable ref publication', ({ targetRef, expected }) => {
    expect(resolveCommitRefPath(
      canonicalGitDirectory,
      canonicalCommonGitDirectory,
      targetRef,
    )).toBe(expected)
  })

  it.each([
    { name: 'rejects an empty ref target', targetRef: '' },
    { name: 'rejects a non-ref target', targetRef: 'heads/main' },
    { name: 'rejects an absolute ref target', targetRef: resolve('outside') },
    { name: 'rejects a ref target resolving to the common directory', targetRef: 'refs/..' },
    { name: 'rejects a ref target resolving to its parent', targetRef: 'refs/../..' },
    { name: 'rejects a ref target traversing beyond its parent', targetRef: 'refs/../../outside' },
  ] as const)('$name', ({ targetRef }) => {
    expect(() => resolveCommitRefPath(
      canonicalGitDirectory,
      canonicalCommonGitDirectory,
      targetRef,
    )).toThrow('unsafe durable Commit ref target')
  })

  it('lists durable parent directories from the leaf to the trusted root', () => {
    const refPath = resolve(canonicalCommonGitDirectory, 'refs', 'heads', 'main')
    expect(parentDirectoryChain(refPath, canonicalCommonGitDirectory)).toEqual([
      resolve(canonicalCommonGitDirectory, 'refs', 'heads'),
      resolve(canonicalCommonGitDirectory, 'refs'),
      canonicalCommonGitDirectory,
    ])
  })

  it('rejects a durable parent walk that cannot reach its trusted root', () => {
    const outsidePath = resolve(canonicalCommonGitDirectory, '..', 'outside', 'ref')
    expect(() => parentDirectoryChain(outsidePath, canonicalCommonGitDirectory))
      .toThrow('Git publication path escaped its common directory')
  })

  it.each([
    {
      name: 'accepts an ordinary object root',
      observation: { kind: 'root', directory: true, symlink: false },
      expected: 'continue',
    },
    {
      name: 'rejects a non-directory object root',
      observation: { kind: 'root', directory: false, symlink: false },
      expected: 'unavailable',
    },
    {
      name: 'rejects a symlinked object root',
      observation: { kind: 'root', directory: true, symlink: true },
      expected: 'unavailable',
    },
    {
      name: 'accepts the complete root-entry bound with info',
      observation: { kind: 'root-entries', entryCount: 257, hasInfo: true },
      expected: 'continue',
    },
    {
      name: 'rejects too many root entries',
      observation: { kind: 'root-entries', entryCount: 258, hasInfo: true },
      expected: 'unavailable',
    },
    {
      name: 'rejects an object root without info',
      observation: { kind: 'root-entries', entryCount: 1, hasInfo: false },
      expected: 'unavailable',
    },
    {
      name: 'accepts an owned same-device directory',
      observation: { kind: 'owned-directory', directory: true, symlink: false, sameDevice: true },
      expected: 'continue',
    },
    {
      name: 'rejects a non-directory owned directory',
      observation: { kind: 'owned-directory', directory: false, symlink: false, sameDevice: true },
      expected: 'unavailable',
    },
    {
      name: 'rejects a symlinked owned directory',
      observation: { kind: 'owned-directory', directory: true, symlink: true, sameDevice: true },
      expected: 'unavailable',
    },
    {
      name: 'rejects a cross-device owned directory',
      observation: { kind: 'owned-directory', directory: true, symlink: false, sameDevice: false },
      expected: 'unavailable',
    },
    {
      name: 'accepts a lowercase hexadecimal fanout name',
      observation: { kind: 'fanout-name', name: 'af' },
      expected: 'continue',
    },
    {
      name: 'rejects a non-fanout root entry',
      observation: { kind: 'fanout-name', name: 'pack' },
      expected: 'unavailable',
    },
    {
      name: 'accepts the exact object-count bound',
      observation: { kind: 'object-count', retainedCount: 2, candidateCount: 3, maxObjectCount: 5 },
      expected: 'continue',
    },
    {
      name: 'rejects an object-count overflow',
      observation: { kind: 'object-count', retainedCount: 2, candidateCount: 4, maxObjectCount: 5 },
      expected: 'unavailable',
    },
    {
      name: 'accepts a SHA-1 loose-object suffix',
      observation: { kind: 'object-suffix', suffix: 'a'.repeat(38), objectIdWidth: 40 },
      expected: 'continue',
    },
    {
      name: 'accepts a SHA-256 loose-object suffix',
      observation: { kind: 'object-suffix', suffix: 'b'.repeat(62), objectIdWidth: 64 },
      expected: 'continue',
    },
    {
      name: 'rejects a short loose-object suffix',
      observation: { kind: 'object-suffix', suffix: 'a'.repeat(37), objectIdWidth: 40 },
      expected: 'unavailable',
    },
    {
      name: 'rejects a non-lowercase loose-object suffix',
      observation: { kind: 'object-suffix', suffix: 'A'.repeat(38), objectIdWidth: 40 },
      expected: 'unavailable',
    },
    {
      name: 'accepts an owned same-device object file',
      observation: { kind: 'owned-file', file: true, symlink: false, sameDevice: true },
      expected: 'continue',
    },
    {
      name: 'rejects a non-file object',
      observation: { kind: 'owned-file', file: false, symlink: false, sameDevice: true },
      expected: 'unavailable',
    },
    {
      name: 'rejects a symlinked object file',
      observation: { kind: 'owned-file', file: true, symlink: true, sameDevice: true },
      expected: 'unavailable',
    },
    {
      name: 'rejects a cross-device object file',
      observation: { kind: 'owned-file', file: true, symlink: false, sameDevice: false },
      expected: 'unavailable',
    },
  ] satisfies readonly {
    readonly name: string
    readonly observation: OwnedLooseObjectManifestObservation
    readonly expected: 'continue' | 'unavailable'
  }[])('$name', ({ observation, expected }) => {
    const requireObservation = (): void => {
      requireOwnedLooseObjectManifestObservation(observation)
    }
    if (expected === 'continue') expect(requireObservation).not.toThrow()
    else expect(requireObservation).toThrow(RetryableMutationError)
  })

  it('groups exact loose-object ids by their fanout directory', () => {
    const objectDirectory = resolve(canonicalCommonGitDirectory, 'objects')
    const first = `aa${'1'.repeat(38)}`
    const second = `aa${'2'.repeat(38)}`
    const third = `bb${'3'.repeat(38)}`
    expect([...groupLooseObjectIdsByFanout(objectDirectory, [first, second, third])]).toEqual([
      [join(objectDirectory, 'aa'), [first, second]],
      [join(objectDirectory, 'bb'), [third]],
    ])
  })

  it.each([
    {
      name: 'reports an existing path',
      lstat: async () => undefined,
      expected: false,
    },
    {
      name: 'reports a missing path',
      lstat: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT', errno: -4_058, syscall: 'lstat' })
      },
      expected: true,
    },
    {
      name: 'does not reinterpret an unavailable probe as missing',
      lstat: async () => { throw NODE_ERRNO },
      expected: false,
    },
  ] as const)('$name', async ({ lstat, expected }) => {
    await expect(nodePathMissing(
      { lstat },
      resolve(canonicalCommonGitDirectory, 'path'),
      new AbortController().signal,
    )).resolves.toBe(expected)
  })

  it('preserves an abort raised by a successful missing-path probe', async () => {
    const controller = new AbortController()
    const reason = new Error('stopped after lstat')
    await expect(nodePathMissing(
      {
        async lstat() {
          controller.abort(reason)
        },
      },
      resolve(canonicalCommonGitDirectory, 'path'),
      controller.signal,
    )).rejects.toBe(reason)
  })

  it.each([
    {
      name: 'parses a SHA-1 object with LF',
      stdout: Buffer.from(`${OBJECT_A}\n`, 'utf8'),
      width: 40,
      expected: OBJECT_A,
    },
    {
      name: 'parses a SHA-256 object with CRLF',
      stdout: Buffer.from(`${SHA256_OBJECT}\r\n`, 'utf8'),
      width: 64,
      expected: SHA256_OBJECT,
    },
  ] as const)('$name', ({ stdout, width, expected }) => {
    expect(parseGitObjectId(stdout, Buffer.alloc(0), width)).toBe(expected)
  })

  it.each([
    {
      name: 'rejects nonempty stderr',
      stdout: Buffer.from(`${OBJECT_A}\n`, 'utf8'),
      stderr: Buffer.from('unexpected stderr\n', 'utf8'),
      width: 40,
    },
    {
      name: 'rejects fatal UTF-8 output',
      stdout: Buffer.from([0xc3, 0x28]),
      stderr: Buffer.alloc(0),
      width: 40,
    },
    { name: 'rejects missing output', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), width: 40 },
    {
      name: 'rejects multiple output lines',
      stdout: Buffer.from(`${OBJECT_A}\n${OBJECT_A}\n`, 'utf8'),
      stderr: Buffer.alloc(0),
      width: 40,
    },
    {
      name: 'rejects an all-zero object',
      stdout: Buffer.from(`${'0'.repeat(40)}\n`, 'utf8'),
      stderr: Buffer.alloc(0),
      width: 40,
    },
    {
      name: 'rejects an object with the wrong width',
      stdout: Buffer.from(`${SHA256_OBJECT}\n`, 'utf8'),
      stderr: Buffer.alloc(0),
      width: 40,
    },
  ] as const)('$name', ({ stdout, stderr, width }) => {
    let thrown: unknown
    try {
      parseGitObjectId(stdout, stderr, width)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(GitCommandError)
    expect(thrown).toMatchObject({ code: 'stream-failure' })
  })

  it.each([
    {
      name: 'accepts exact target evidence before considering publication state',
      evidence: {
        kind: 'index',
        actual: INDEX_B,
        expected: INDEX_A,
        target: INDEX_B,
        publication: 'not-started',
        allowResume: false,
      },
      expected: { kind: 'succeeded' },
    },
    {
      name: 'resumes an exact not-started index when authorized',
      evidence: {
        kind: 'index',
        actual: INDEX_A,
        expected: INDEX_A,
        target: INDEX_B,
        publication: 'not-started',
        allowResume: true,
      },
      expected: { kind: 'resume' },
    },
    {
      name: 'leaves an exact not-started index retryable during inspection',
      evidence: {
        kind: 'index',
        actual: INDEX_A,
        expected: INDEX_A,
        target: INDEX_B,
        publication: 'not-started',
        allowResume: false,
      },
      expected: { kind: 'retryable', reason: 'unavailable' },
    },
    {
      name: 'fails a drifted not-started index before effect',
      evidence: {
        kind: 'index',
        actual: INDEX_C,
        expected: INDEX_A,
        target: INDEX_B,
        publication: 'not-started',
        allowResume: true,
      },
      expected: { kind: 'no-effect', reason: 'observation-stale' },
    },
    {
      name: 'reconciles conflicting evidence after an index attempt',
      evidence: {
        kind: 'index',
        actual: INDEX_C,
        expected: INDEX_A,
        target: INDEX_B,
        publication: 'attempting',
        allowResume: true,
      },
      expected: { kind: 'reconciliation', reason: 'evidence-conflict' },
    },
  ] as const)('$name', ({ evidence, expected }) => {
    expect(decideGitPublicationRecovery(evidence)).toEqual(expected)
  })

  it.each([
    {
      name: 'gives an abort reason precedence over an index read failure',
      error: new NoEffectMutationError('unsupported-state'),
      publication: 'not-started',
      interruption: { aborted: true, reason: ABORT_REASON },
      expectedKind: 'aborted',
      expectedValue: ABORT_REASON,
    },
    {
      name: 'retains a no-effect reason before index publication starts',
      error: new NoEffectMutationError('unsupported-state'),
      publication: 'not-started',
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'no-effect',
      expectedValue: 'unsupported-state',
    },
    {
      name: 'requires reconciliation after an attempted index publication cannot be observed',
      error: new NoEffectMutationError('unsupported-state'),
      publication: 'attempting',
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'reconciliation',
      expectedValue: 'evidence-conflict',
    },
    {
      name: 'requires reconciliation after recorded index publication cannot be observed',
      error: new NoEffectMutationError('unsupported-state'),
      publication: 'applied-recorded',
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'reconciliation',
      expectedValue: 'evidence-conflict',
    },
    {
      name: 'maps a retryable index read failure to unavailable',
      error: new RetryableMutationError('busy'),
      publication: 'not-started',
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'retryable',
      expectedValue: 'unavailable',
    },
    {
      name: 'maps a Node index read failure to unavailable',
      error: NODE_ERRNO,
      publication: 'attempting',
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'retryable',
      expectedValue: 'unavailable',
    },
    {
      name: 'retains an unexpected index read failure for the caller to throw',
      error: UNEXPECTED_ERROR,
      publication: 'not-started',
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'unexpected',
      expectedValue: UNEXPECTED_ERROR,
    },
    {
      name: 'does not mistake a coded programming error for a Node system failure',
      error: CODED_PROGRAM_ERROR,
      publication: 'attempting',
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'unexpected',
      expectedValue: CODED_PROGRAM_ERROR,
    },
    {
      name: 'does not trust a duck-typed Node system failure across the Error boundary',
      error: DUCK_SYSTEM_ERROR,
      publication: 'attempting',
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'unexpected',
      expectedValue: DUCK_SYSTEM_ERROR,
    },
    {
      name: 'does not mistake an incomplete errno error for a Node system failure',
      error: INCOMPLETE_SYSTEM_ERROR,
      publication: 'attempting',
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'unexpected',
      expectedValue: INCOMPLETE_SYSTEM_ERROR,
    },
  ] as const)('index recovery read: $name', ({ error, publication, interruption, expectedKind, expectedValue }) => {
    const decision = decideGitIndexRecoveryReadFailure(error, publication, interruption)
    expect(decision.kind).toBe(expectedKind)
    if (decision.kind === 'unexpected') expect(decision.error).toBe(expectedValue)
    else expect(decision.reason).toBe(expectedValue)
  })

  it.each([
    {
      name: 'preserves caller cancellation above a cancel index evidence failure',
      error: UNEXPECTED_ERROR,
      interruption: { aborted: true, reason: ABORT_REASON },
      expectedKind: 'aborted',
      expectedValue: ABORT_REASON,
    },
    {
      name: 'retains publishing after a normalized index EIO',
      error: new RetryableMutationError('unavailable'),
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'retain',
      expectedValue: undefined,
    },
    {
      name: 'retains publishing after non-regular index evidence',
      error: new NoEffectMutationError('unsupported-state'),
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'retain',
      expectedValue: undefined,
    },
    {
      name: 'retains an unexpected cancel index evidence error for the caller',
      error: UNEXPECTED_ERROR,
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'unexpected',
      expectedValue: UNEXPECTED_ERROR,
    },
  ] as const)('cancel index evidence: $name', ({ error, interruption, expectedKind, expectedValue }) => {
    const decision = decideCancelIndexEvidenceFailure(error, interruption)
    expect(decision.kind).toBe(expectedKind)
    if (decision.kind === 'aborted') expect(decision.reason).toBe(expectedValue)
    else if (decision.kind === 'unexpected') expect(decision.error).toBe(expectedValue)
    else expect(expectedValue).toBeUndefined()
  })

  it.each([
    {
      name: 'preserves caller cancellation above a cancel target read failure',
      error: UNEXPECTED_ERROR,
      interruption: { aborted: true, reason: ABORT_REASON },
      expectedKind: 'aborted',
      expectedValue: ABORT_REASON,
    },
    {
      name: 'retains publishing after a Git target read failure',
      error: new GitCommandError('spawn-failure'),
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'retain',
      expectedValue: undefined,
    },
    {
      name: 'retains an unexpected cancel target error for the caller',
      error: UNEXPECTED_ERROR,
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'unexpected',
      expectedValue: UNEXPECTED_ERROR,
    },
  ] as const)('cancel target read: $name', ({ error, interruption, expectedKind, expectedValue }) => {
    const decision = decideCancelTargetReadFailure(error, interruption)
    expect(decision.kind).toBe(expectedKind)
    if (decision.kind === 'aborted') expect(decision.reason).toBe(expectedValue)
    else if (decision.kind === 'unexpected') expect(decision.error).toBe(expectedValue)
    else expect(expectedValue).toBeUndefined()
  })

  it.each([
    {
      name: 'accepts the exact Commit target without reading the reflog',
      evidence: {
        kind: 'commit',
        current: COMMIT_B,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'attempting',
        reflog: 'absent',
        allowResume: false,
        detachedExpectedHead: false,
      },
      expected: { kind: 'succeeded' },
    },
    {
      name: 'rejects a historical detached not-started Commit even when HEAD resolves to the candidate',
      evidence: {
        kind: 'commit',
        current: COMMIT_B,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'not-started',
        reflog: 'absent',
        allowResume: true,
        detachedExpectedHead: true,
      },
      expected: { kind: 'no-effect', reason: 'unsupported-state' },
    },
    {
      name: 'does not accept a historical detached candidate without its exact reflog marker',
      evidence: {
        kind: 'commit',
        current: COMMIT_B,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'attempting',
        reflog: 'absent',
        allowResume: false,
        detachedExpectedHead: true,
      },
      expected: { kind: 'reconciliation', reason: 'evidence-conflict' },
    },
    {
      name: 'accepts a historical detached candidate with its exact reflog marker',
      evidence: {
        kind: 'commit',
        current: COMMIT_B,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'attempting',
        reflog: 'found',
        allowResume: false,
        detachedExpectedHead: true,
      },
      expected: { kind: 'succeeded' },
    },
    {
      name: 'keeps a historical detached candidate retryable while its reflog is unavailable',
      evidence: {
        kind: 'commit',
        current: COMMIT_B,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'attempting',
        reflog: 'unavailable',
        allowResume: false,
        detachedExpectedHead: true,
      },
      expected: { kind: 'retryable', reason: 'unavailable' },
    },
    {
      name: 'marks a historical detached candidate with an oversized reflog as effect-unknown',
      evidence: {
        kind: 'commit',
        current: COMMIT_B,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'attempting',
        reflog: 'limit',
        allowResume: false,
        detachedExpectedHead: true,
      },
      expected: { kind: 'reconciliation', reason: 'effect-unknown' },
    },
    {
      name: 'resumes an exact not-started attached Commit when authorized',
      evidence: {
        kind: 'commit',
        current: COMMIT_A,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'not-started',
        reflog: 'absent',
        allowResume: true,
        detachedExpectedHead: false,
      },
      expected: { kind: 'resume' },
    },
    {
      name: 'matches an unborn not-started Commit against an absent target',
      evidence: {
        kind: 'commit',
        current: undefined,
        expectedOldObjectId: ZERO_COMMIT,
        resultCommitId: COMMIT_B,
        publication: 'not-started',
        reflog: 'absent',
        allowResume: false,
        detachedExpectedHead: false,
      },
      expected: { kind: 'retryable', reason: 'unavailable' },
    },
    {
      name: 'rejects a historical detached not-started Commit before effect',
      evidence: {
        kind: 'commit',
        current: COMMIT_A,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'not-started',
        reflog: 'absent',
        allowResume: true,
        detachedExpectedHead: true,
      },
      expected: { kind: 'no-effect', reason: 'unsupported-state' },
    },
    {
      name: 'fails a drifted not-started Commit before effect',
      evidence: {
        kind: 'commit',
        current: COMMIT_B,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: 'c'.repeat(40),
        publication: 'not-started',
        reflog: 'absent',
        allowResume: true,
        detachedExpectedHead: false,
      },
      expected: { kind: 'no-effect', reason: 'observation-stale' },
    },
    {
      name: 'accepts a Commit found in bounded reflog evidence',
      evidence: {
        kind: 'commit',
        current: COMMIT_A,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'attempting',
        reflog: 'found',
        allowResume: false,
        detachedExpectedHead: false,
      },
      expected: { kind: 'succeeded' },
    },
    {
      name: 'retries unavailable Commit reflog evidence',
      evidence: {
        kind: 'commit',
        current: COMMIT_A,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'attempting',
        reflog: 'unavailable',
        allowResume: false,
        detachedExpectedHead: false,
      },
      expected: { kind: 'retryable', reason: 'unavailable' },
    },
    {
      name: 'marks a bounded reflog limit as effect-unknown',
      evidence: {
        kind: 'commit',
        current: COMMIT_A,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'attempting',
        reflog: 'limit',
        allowResume: false,
        detachedExpectedHead: false,
      },
      expected: { kind: 'reconciliation', reason: 'effect-unknown' },
    },
    {
      name: 'marks absent attempted Commit evidence as conflicting',
      evidence: {
        kind: 'commit',
        current: COMMIT_A,
        expectedOldObjectId: COMMIT_A,
        resultCommitId: COMMIT_B,
        publication: 'attempting',
        reflog: 'absent',
        allowResume: false,
        detachedExpectedHead: false,
      },
      expected: { kind: 'reconciliation', reason: 'evidence-conflict' },
    },
  ] as const)('$name', ({ evidence, expected }) => {
    expect(decideGitPublicationRecovery(evidence)).toEqual(expected)
  })

  it.each([
    {
      name: 'gives an abort reason precedence over the caught failure',
      error: new RetryableMutationError('busy'),
      interruption: { aborted: true, reason: ABORT_REASON },
      expectedKind: 'aborted',
      expectedValue: ABORT_REASON,
    },
    {
      name: 'retains a busy retry classification',
      error: new RetryableMutationError('busy'),
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'retryable',
      expectedValue: 'busy',
    },
    {
      name: 'maps a Git command failure to unavailable',
      error: new GitCommandError('timeout'),
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'retryable',
      expectedValue: 'unavailable',
    },
    {
      name: 'retains the exact no-effect reason',
      error: new NoEffectMutationError('invalid-selection'),
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'no-effect',
      expectedValue: 'invalid-selection',
    },
    {
      name: 'retains an unexpected error for the caller to throw',
      error: UNEXPECTED_ERROR,
      interruption: { aborted: false, reason: undefined },
      expectedKind: 'unexpected',
      expectedValue: UNEXPECTED_ERROR,
    },
  ] as const)('$name', ({ error, interruption, expectedKind, expectedValue }) => {
    const decision = classifyGitMutationError(error, interruption)
    expect(decision.kind).toBe(expectedKind)
    if (decision.kind === 'unexpected') expect(decision.error).toBe(expectedValue)
    else expect(decision.reason).toBe(expectedValue)
  })

  it.each([
    {
      name: 'rejects executable-filter staging as unsupported',
      operation: 'stage-files',
      ...SELECTION_FIXTURES.executableFilter,
      expected: { kind: 'reject', reason: 'unsupported-state' },
    },
    {
      name: 'rejects an unchanged worktree selection for staging',
      operation: 'stage-files',
      ...SELECTION_FIXTURES.staged,
      expected: { kind: 'reject', reason: 'invalid-selection' },
    },
    {
      name: 'rejects unavailable captured worktree evidence',
      operation: 'stage-files',
      ...SELECTION_FIXTURES.unavailable,
      expected: { kind: 'reject', reason: 'unsupported-state' },
    },
    {
      name: 'rejects captured worktree evidence without its raw object id',
      operation: 'stage-files',
      ...SELECTION_FIXTURES.missingObjectId,
      expected: { kind: 'reject', reason: 'unsupported-state' },
    },
    {
      name: 'removes a missing worktree path from the index',
      operation: 'stage-files',
      ...SELECTION_FIXTURES.missing,
      expected: { kind: 'remove' },
    },
    {
      name: 'uses the exact submodule object without hashing worktree bytes',
      operation: 'stage-files',
      ...SELECTION_FIXTURES.submodule,
      expected: { kind: 'use-object', mode: '160000', objectId: OBJECT_B },
    },
    {
      name: 'requires bounded worktree hashing for a regular file',
      operation: 'stage-files',
      ...SELECTION_FIXTURES.unstaged,
      expected: {
        kind: 'hash-worktree',
        current: REGULAR_ENTRY.current,
        evidence: REGULAR_ENTRY.current.evidence,
        expectedObjectId: OBJECT_B,
        mode: '100644',
      },
    },
    {
      name: 'requires bounded worktree hashing with the frozen symlink mode',
      operation: 'stage-files',
      ...SELECTION_FIXTURES.symlink,
      expected: {
        kind: 'hash-worktree',
        current: SYMLINK_ENTRY.current,
        evidence: SYMLINK_ENTRY.current.evidence,
        expectedObjectId: OBJECT_B,
        mode: '120000',
      },
    },
    {
      name: 'rejects an untracked path for unstaging',
      operation: 'unstage-files',
      ...SELECTION_FIXTURES.untracked,
      expected: { kind: 'reject', reason: 'invalid-selection' },
    },
    {
      name: 'rejects an unchanged index selection for unstaging',
      operation: 'unstage-files',
      ...SELECTION_FIXTURES.unstaged,
      expected: { kind: 'reject', reason: 'invalid-selection' },
    },
    {
      name: 'restores the exact HEAD object while unstaging',
      operation: 'unstage-files',
      ...SELECTION_FIXTURES.staged,
      expected: { kind: 'use-object', mode: '100644', objectId: OBJECT_A },
    },
    {
      name: 'removes an index-only path while unstaging',
      operation: 'unstage-files',
      ...SELECTION_FIXTURES.indexOnly,
      expected: { kind: 'remove' },
    },
  ] as const)('$name', ({ operation, change, entry, expected }) => {
    expect(projectGitChangeSchema.parse(change)).toEqual(change)
    expect(decideGitIndexSelection(operation, change, entry)).toEqual(expected)
  })

  it.each([
    {
      name: 'classifies a replaced path identity as foreign',
      observation: {
        kind: 'path',
        stat: { ...OWNED_FILE_STAT, inode: '10' },
      },
      expected: 'foreign',
    },
    {
      name: 'continues after the path identity matches',
      observation: { kind: 'path', stat: OWNED_FILE_STAT },
      expected: 'continue',
    },
    {
      name: 'classifies a replaced opened identity as unavailable',
      observation: {
        kind: 'opened',
        path: OWNED_FILE_STAT,
        opened: { ...OWNED_FILE_STAT, inode: '10' },
      },
      expected: 'unavailable',
    },
    {
      name: 'classifies evidence beyond the configured read bound as corrupt',
      observation: { kind: 'opened', path: OWNED_FILE_STAT, opened: OWNED_FILE_STAT },
      maxBytes: 11,
      expected: 'owned-corrupt',
    },
    {
      name: 'classifies a symlinked owned identity as corrupt',
      observation: {
        kind: 'opened',
        path: { ...OWNED_FILE_STAT, kind: 'symlink' },
        opened: OWNED_FILE_STAT,
      },
      expected: 'owned-corrupt',
    },
    {
      name: 'classifies mismatched owned mode as corrupt',
      observation: {
        kind: 'opened',
        path: { ...OWNED_FILE_STAT, mode: 0o600 },
        opened: OWNED_FILE_STAT,
      },
      expected: 'owned-corrupt',
    },
    {
      name: 'continues after opened metadata matches',
      observation: { kind: 'opened', path: OWNED_FILE_STAT, opened: OWNED_FILE_STAT },
      expected: 'continue',
    },
    {
      name: 'classifies incomplete bytes as corrupt',
      observation: { kind: 'contents', digest: undefined },
      expected: 'owned-corrupt',
    },
    {
      name: 'classifies a digest mismatch as corrupt',
      observation: { kind: 'contents', digest: '2'.repeat(64) },
      expected: 'owned-corrupt',
    },
    {
      name: 'continues after the exact digest matches',
      observation: { kind: 'contents', digest: OWNED_FILE_EVIDENCE.digest },
      expected: 'continue',
    },
    {
      name: 'classifies an in-handle timestamp change as unavailable',
      observation: {
        kind: 'post-read',
        before: OWNED_FILE_STAT,
        after: { ...OWNED_FILE_STAT, modifiedNanoseconds: 31n },
      },
      expected: 'unavailable',
    },
    {
      name: 'continues after the opened file remains stable',
      observation: { kind: 'post-read', before: OWNED_FILE_STAT, after: OWNED_FILE_STAT },
      expected: 'continue',
    },
    {
      name: 'classifies a final path replacement as foreign',
      observation: {
        kind: 'current',
        before: OWNED_FILE_STAT,
        current: { ...OWNED_FILE_STAT, device: '8' },
      },
      expected: 'foreign',
    },
    {
      name: 'classifies final metadata drift as corrupt',
      observation: {
        kind: 'current',
        before: OWNED_FILE_STAT,
        current: { ...OWNED_FILE_STAT, byteLength: 13n },
      },
      expected: 'owned-corrupt',
    },
    {
      name: 'classifies stable final evidence as owned',
      observation: { kind: 'current', before: OWNED_FILE_STAT, current: OWNED_FILE_STAT },
      expected: 'owned',
    },
  ] as const)('$name', ({ observation, maxBytes = 12, expected }) => {
    expect(classifyOwnedFileObservation(observation, OWNED_FILE_EVIDENCE, maxBytes)).toBe(expected)
  })
})
