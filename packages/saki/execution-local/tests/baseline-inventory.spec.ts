import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InheritedChangeBaselineBounds } from '@breakfastdapaidang/saki-execution'
import {
  buildInheritedChangeBaseline,
  type CapturedRepositoryInventory,
} from '../src/baseline.ts'

const BOUNDS: InheritedChangeBaselineBounds = {
  maxEntries: 10,
  maxPathBytes: 1_024,
  maxGitOutputBytes: 64 * 1_024,
  maxFileBytes: 1_024,
  maxTotalFileBytes: 4_096,
  maxCaptureMs: 10_000,
}

const GIT_OBJECT = { mode: '100644' as const, objectId: '1'.repeat(40) }

type CapturedEntry = CapturedRepositoryInventory['entries'][number]
type CapturedEntryOverrides = Omit<Partial<CapturedEntry>, 'head' | 'index'> & {
  readonly head?: NonNullable<CapturedEntry['head']> | null
  readonly index?: NonNullable<CapturedEntry['index']> | null
}

function capturedEntry(
  overrides: CapturedEntryOverrides = {},
): CapturedEntry {
  const { head = GIT_OBJECT, index = GIT_OBJECT, ...members } = overrides
  return {
    path: Buffer.from('tracked.txt'),
    stages: [undefined, undefined, undefined],
    untracked: false,
    current: {
      kind: 'captured',
      evidence: { kind: 'regular', mode: '100644', byteLength: 7, contentDigest: '2'.repeat(64) },
      rawObjectId: '3'.repeat(40),
      rawByteLength: 7,
      gitEvidenceBytes: 0,
    },
    conversion: { executableFilter: false, unmodeled: false, lineEnding: false },
    ...members,
    ...(head === null ? {} : { head }),
    ...(index === null ? {} : { index }),
  }
}

function inventory(
  entries: CapturedRepositoryInventory['entries'],
  overrides: Partial<Omit<CapturedRepositoryInventory, 'entries'>> = {},
): CapturedRepositoryInventory {
  return {
    objectFormat: 'sha1',
    comparison: { fileMode: false, symlinks: true, autocrlf: false },
    allowlistedGitEvidenceBytes: 0,
    capture: {
      elapsedMs: 0,
      rawBytes: entries.reduce((total, entry) => total
        + (entry.current.kind === 'captured' ? entry.current.rawByteLength : 0), 0),
    },
    entries,
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('closed-inventory inherited-change baseline', () => {
  it('retains explicit HEAD, index, and current evidence for one raw-changed path', () => {
    const inventory: CapturedRepositoryInventory = {
      objectFormat: 'sha1',
      comparison: { fileMode: false, symlinks: true, autocrlf: false },
      allowlistedGitEvidenceBytes: 123,
      capture: { elapsedMs: 5, rawBytes: 7 },
      entries: [{
        path: Buffer.from('tracked.txt'),
        head: { mode: '100644', objectId: '1'.repeat(40) },
        index: { mode: '100644', objectId: '1'.repeat(40) },
        stages: [undefined, undefined, undefined],
        untracked: false,
        current: {
          kind: 'captured',
          evidence: {
            kind: 'regular', mode: '100644', byteLength: 7, contentDigest: '2'.repeat(64),
          },
          rawObjectId: '3'.repeat(40),
          rawByteLength: 7,
          gitEvidenceBytes: 0,
        },
        conversion: { executableFilter: false, unmodeled: false, lineEnding: false },
      }],
    }

    const result = buildInheritedChangeBaseline(inventory, BOUNDS, 1234, new AbortController().signal)

    expect(result).toMatchObject({
      inheritedChangeEntryCount: 1,
      conversionAmbiguous: false,
      baseline: {
        kind: 'complete',
        capturedAt: 1234,
        observed: {
          entries: 1, pathBytes: 11, gitOutputBytes: 123, hashedBytes: 7,
        },
        entries: [{
          statusKind: 'tracked',
          head: { kind: 'object', mode: '100644', objectId: '1'.repeat(40) },
          index: { kind: 'object', mode: '100644', objectId: '1'.repeat(40) },
          worktree: { kind: 'regular', contentDigest: '2'.repeat(64) },
        }],
      },
    })
    expect(result.baseline.observed.elapsedMs).toBeGreaterThanOrEqual(5)
  })

  it('classifies each independent retention limit before building entries', () => {
    const entry = capturedEntry()
    for (const [captured, bounds, reason] of [
      [inventory([entry]), { ...BOUNDS, maxEntries: 0 }, 'entry-limit'],
      [inventory([entry], { capture: { elapsedMs: 0, rawBytes: 0 } }), BOUNDS, 'io-failure'],
      [inventory([entry]), { ...BOUNDS, maxPathBytes: 1 }, 'path-limit'],
      [inventory([entry], { allowlistedGitEvidenceBytes: BOUNDS.maxGitOutputBytes + 1 }), BOUNDS, 'git-output-limit'],
      [inventory([entry]), { ...BOUNDS, maxFileBytes: 6 }, 'file-limit'],
      [inventory([entry]), { ...BOUNDS, maxTotalFileBytes: 6 }, 'hash-limit'],
      [inventory([entry], { capture: { elapsedMs: BOUNDS.maxCaptureMs + 1, rawBytes: 7 } }), BOUNDS, 'time-limit'],
    ] as const) {
      expect(buildInheritedChangeBaseline(captured, bounds, 1, new AbortController().signal).baseline)
        .toMatchObject({ kind: 'unavailable', reason })
    }
  })

  it('retains unmerged, untracked, and missing object slots and rejects unsupported membership', () => {
    const unmerged = capturedEntry({
      path: Buffer.from('a-unmerged'),
      stages: [GIT_OBJECT, undefined, undefined],
      head: null,
      index: null,
    })
    const untracked = capturedEntry({
      path: Buffer.from('b-untracked'),
      head: null,
      index: null,
      untracked: true,
      current: {
        kind: 'captured',
        evidence: { kind: 'symlink', targetDigest: '4'.repeat(64) },
        rawObjectId: '5'.repeat(40),
        rawByteLength: 5,
        gitEvidenceBytes: 0,
      },
    })
    const retained = buildInheritedChangeBaseline(inventory([unmerged, untracked]), BOUNDS, 1, new AbortController().signal)
    expect(retained.baseline).toMatchObject({
      kind: 'complete',
      entries: [
        { statusKind: 'unmerged', head: { kind: 'missing' } },
        { statusKind: 'untracked', worktree: { kind: 'symlink' } },
      ],
    })

    for (const unsupported of [
      capturedEntry({ head: null, index: null }),
      capturedEntry({
        head: null,
        index: null,
        untracked: true,
        current: {
          kind: 'captured',
          evidence: { kind: 'submodule', objectId: '6'.repeat(40) },
          rawObjectId: '6'.repeat(40),
          rawByteLength: 0,
          gitEvidenceBytes: 40,
        },
      }),
    ]) {
      expect(buildInheritedChangeBaseline(inventory([unsupported]), BOUNDS, 1, new AbortController().signal).baseline)
        .toMatchObject({ kind: 'unavailable', reason: 'unsupported-state' })
    }
  })

  it('detects duplicate paths and preserves unavailable current evidence', () => {
    const duplicate = capturedEntry()
    expect(buildInheritedChangeBaseline(
      inventory([duplicate, { ...duplicate }]), BOUNDS, 1, new AbortController().signal,
    ).baseline).toMatchObject({ kind: 'unavailable', reason: 'duplicate-path' })

    for (const conversion of [
      { executableFilter: true, unmodeled: false, lineEnding: false },
      { executableFilter: false, unmodeled: true, lineEnding: false },
      { executableFilter: false, unmodeled: false, lineEnding: true },
    ]) {
      const unavailable = capturedEntry({
        current: { kind: 'unavailable', reason: 'unstable-content' },
        conversion,
      })
      const result = buildInheritedChangeBaseline(
        inventory([unavailable], { comparison: { fileMode: false, symlinks: true, autocrlf: true } }),
        BOUNDS,
        1,
        new AbortController().signal,
      )
      expect(result.baseline).toMatchObject({ kind: 'unavailable', reason: 'unstable-content' })
    }
  })

  it('compares every current evidence kind and repository mode rule', () => {
    const unchanged = [
      capturedEntry({
        current: {
          kind: 'captured', evidence: { kind: 'missing' }, rawByteLength: 0, gitEvidenceBytes: 0,
        },
        head: null,
        index: null,
      }),
      capturedEntry({
        current: {
          kind: 'captured', evidence: { kind: 'symlink', targetDigest: '2'.repeat(64) },
          rawObjectId: '1'.repeat(40), rawByteLength: 1, gitEvidenceBytes: 0,
        },
        head: { mode: '120000', objectId: '1'.repeat(40) },
        index: { mode: '120000', objectId: '1'.repeat(40) },
      }),
      capturedEntry({
        current: {
          kind: 'captured', evidence: { kind: 'submodule', objectId: '1'.repeat(40) },
          rawObjectId: '1'.repeat(40), rawByteLength: 0, gitEvidenceBytes: 40,
        },
        head: { mode: '160000', objectId: '1'.repeat(40) },
        index: { mode: '160000', objectId: '1'.repeat(40) },
      }),
      capturedEntry({
        current: {
          kind: 'captured',
          evidence: { kind: 'regular', mode: '100644', byteLength: 7, contentDigest: '2'.repeat(64) },
          rawObjectId: '1'.repeat(40), rawByteLength: 7, gitEvidenceBytes: 0,
        },
      }),
    ]
    expect(buildInheritedChangeBaseline(inventory(unchanged), BOUNDS, 1, new AbortController().signal))
      .toMatchObject({
        inheritedChangeEntryCount: 0,
        conversionAmbiguous: true,
        baseline: { kind: 'complete', entries: [] },
      })

    const regularThroughSymlink = capturedEntry({
      head: { mode: '120000', objectId: '1'.repeat(40) },
      index: { mode: '120000', objectId: '1'.repeat(40) },
      current: {
        kind: 'captured',
        evidence: { kind: 'regular', mode: '100644', byteLength: 7, contentDigest: '2'.repeat(64) },
        rawObjectId: '1'.repeat(40), rawByteLength: 7, gitEvidenceBytes: 0,
      },
    })
    expect(buildInheritedChangeBaseline(
      inventory([regularThroughSymlink], { comparison: { fileMode: false, symlinks: false, autocrlf: false } }),
      BOUNDS,
      1,
      new AbortController().signal,
    ).inheritedChangeEntryCount).toBe(0)

    for (const changed of [
      capturedEntry({ head: null }),
      capturedEntry({ index: { mode: '100755', objectId: '1'.repeat(40) } }),
      capturedEntry({ index: { mode: '100644', objectId: '2'.repeat(40) } }),
      capturedEntry({
        head: { mode: '160000', objectId: '1'.repeat(40) },
        index: { mode: '160000', objectId: '1'.repeat(40) },
        current: {
          kind: 'captured',
          evidence: { kind: 'regular', mode: '100644', byteLength: 7, contentDigest: '2'.repeat(64) },
          rawObjectId: '1'.repeat(40), rawByteLength: 7, gitEvidenceBytes: 0,
        },
      }),
      capturedEntry({
        current: {
          kind: 'captured',
          evidence: { kind: 'regular', mode: '100755', byteLength: 7, contentDigest: '2'.repeat(64) },
          rawObjectId: '1'.repeat(40), rawByteLength: 7, gitEvidenceBytes: 0,
        },
      }),
      capturedEntry({
        current: {
          kind: 'captured', evidence: { kind: 'missing' }, rawObjectId: '1'.repeat(40),
          rawByteLength: 0, gitEvidenceBytes: 0,
        },
      }),
    ]) {
      expect(buildInheritedChangeBaseline(
        inventory([changed], { comparison: { fileMode: true, symlinks: true, autocrlf: false } }),
        BOUNDS,
        1,
        new AbortController().signal,
      ).inheritedChangeEntryCount).toBe(1)
    }

    for (const rawObjectId of ['1'.repeat(40), '2'.repeat(40)]) {
      const converted = capturedEntry({
        current: {
          kind: 'captured',
          evidence: { kind: 'regular', mode: '100644', byteLength: 7, contentDigest: '2'.repeat(64) },
          rawObjectId,
          rawByteLength: 7,
          gitEvidenceBytes: 0,
        },
        conversion: { executableFilter: false, unmodeled: false, lineEnding: true },
      })
      expect(buildInheritedChangeBaseline(
        inventory([converted]), BOUNDS, 1, new AbortController().signal,
      ).conversionAmbiguous).toBe(rawObjectId !== '1'.repeat(40))
    }
  })

  it('checks capture time before each entry and after the final digest', () => {
    const entry = capturedEntry()
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(11)
    expect(buildInheritedChangeBaseline(
      inventory([entry]), { ...BOUNDS, maxCaptureMs: 10 }, 1, new AbortController().signal,
    ).baseline).toMatchObject({ kind: 'unavailable', reason: 'time-limit' })

    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(11)
    expect(buildInheritedChangeBaseline(
      inventory([entry]), { ...BOUNDS, maxCaptureMs: 10 }, 1, new AbortController().signal,
    ).baseline).toMatchObject({ kind: 'unavailable', reason: 'time-limit' })
  })
})
