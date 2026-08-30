import { createHash } from 'node:crypto'
import type {
  InheritedChangeBaseline,
  ProjectSelectionInspection,
  SakiHostId,
  SakiResourceBindingId,
} from '@breakfastdapaidang/saki-execution'
import {
  MAX_PROJECT_GIT_STATUS_CHANGES,
  MAX_PROJECT_GIT_STATUS_PATH_BYTES,
  projectGitStatusObservationSchema,
} from '@breakfastdapaidang/saki-execution'
import { describe, expect, it } from 'vitest'
import {
  buildInheritedChangeBaseline,
  type CapturedInventoryGitObject,
  type CapturedRepositoryInventory,
  type CapturedRepositoryInventoryEntry,
} from '../src/baseline.ts'
import {
  buildProjectGitStatusObservation,
  assertProjectGitStatusChangeFits,
  ProjectGitStatusProjectionError,
} from '../src/status.ts'
import {
  captureVerifiedRepositoryStatus,
  RepositoryStatusError,
  type RepositoryStatusBounds,
  type RepositoryStatusBranchExpectation,
  type VerifiedRepositoryStatus,
} from '../src/status-evidence.ts'
import { projectStatusQueryArguments } from '../src/status-query.ts'
import {
  captureRepositoryIndexFlagEvidence,
  RepositoryInventoryError,
  type RepositoryInventoryGit,
} from '../src/inventory.ts'
import type { ParsedStatusEntry } from '../src/status-porcelain-v2.ts'

const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
const BINDING_ID = 'binding-11111111-1111-4111-8111-111111111111' as SakiResourceBindingId
const HEAD = 'a'.repeat(40)
const INDEX = 'b'.repeat(40)
const RAW = 'c'.repeat(40)
const BASELINE: InheritedChangeBaseline = {
  kind: 'complete',
  formatVersion: 1,
  capturedAt: 1,
  bounds: {
    maxEntries: 10,
    maxPathBytes: 1_000,
    maxGitOutputBytes: 1_000,
    maxFileBytes: 1_000,
    maxTotalFileBytes: 1_000,
    maxCaptureMs: 1_000,
  },
  observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0, elapsedMs: 1 },
  entries: [],
  digest: 'd'.repeat(64),
}

describe('project Git status inventory projection', () => {
  it('projects staged, unstaged, and untracked facts without Host paths', () => {
    const inventory = capturedInventory([
      tracked('tracked.txt', object(HEAD), object(INDEX), RAW),
      untracked('untracked.txt'),
    ])
    const inspection = selectedInspection(BASELINE)

    const observation = buildProjectGitStatusObservation(
      inventory,
      inspection,
      { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: BASELINE },
      new AbortController().signal,
      verifiedStatus(inventory),
      BASELINE,
    )

    expect(observation).toMatchObject({
      observationVersion: 1,
      bindingId: BINDING_ID,
      bindingRevision: 3,
      bindingHealth: 'active',
      locked: false,
      objectFormat: 'sha1',
      head: { kind: 'commit', objectId: HEAD, symbolicRef: 'refs/heads/main' },
      changes: [
        {
          path: 'tracked.txt',
          kind: 'ordinary',
          indexStatus: 'modified',
          worktreeStatus: 'modified',
          attribution: 'not-inherited',
        },
        {
          path: 'untracked.txt',
          kind: 'untracked',
          indexStatus: 'absent',
          worktreeStatus: 'untracked',
          worktreeMode: '100644',
          attribution: 'not-inherited',
        },
      ],
    })
    expect(observation.index.kind).toBe('tree')
    if (observation.index.kind === 'tree') expect(observation.index.treeId).toMatch(/^[0-9a-f]{40}$/u)
    expect(observation.worktree.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(observation.fingerprint.version).toBe(1)
    expect(observation.fingerprint.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(projectGitStatusObservationSchema.parse(observation)).toEqual(observation)
    expect(JSON.stringify(observation)).not.toContain('C:\\private\\repository')
    expect(JSON.stringify(observation)).not.toContain('.git')
  })

  it('classifies conflicts and attributes inherited, mixed, and subsequent paths', () => {
    const inherited = tracked('inherited.txt', object(HEAD), object(HEAD), RAW)
    const mixedAtRegistration = tracked('mixed.txt', object(HEAD), object(HEAD), RAW)
    const built = buildInheritedChangeBaseline(
      capturedInventory([inherited, mixedAtRegistration]),
      BASELINE.bounds,
      1,
      new AbortController().signal,
    )
    expect(built.baseline.kind).toBe('complete')
    const current = capturedInventory([
      inherited,
      tracked('mixed.txt', object(HEAD), object(HEAD), 'd'.repeat(40), 'a'.repeat(64)),
      conflicted('conflicted.txt'),
      untracked('subsequent.txt'),
    ])

    const observation = buildProjectGitStatusObservation(
      current,
      selectedInspection(built.baseline),
      { id: BINDING_ID, revision: 4, health: 'active', inheritedChangeBaseline: built.baseline },
      new AbortController().signal,
      verifiedStatus(current),
      built.baseline,
    )

    expect(observation.changes.map(change => ({
      path: change.path,
      kind: change.kind,
      attribution: change.attribution,
    }))).toEqual([
      { path: 'conflicted.txt', kind: 'unmerged', attribution: 'not-inherited' },
      { path: 'inherited.txt', kind: 'ordinary', attribution: 'inherited' },
      { path: 'mixed.txt', kind: 'ordinary', attribution: 'unattributed' },
      { path: 'subsequent.txt', kind: 'untracked', attribution: 'not-inherited' },
    ])
    expect(observation.changes.every(change => /^git-change-[0-9a-f]{64}$/u.test(change.id))).toBe(true)
  })

  it('binds index and worktree digests to their complete canonical evidence', () => {
    const first = tracked('a.txt', object(HEAD), object(INDEX), RAW)
    const second = tracked('b.txt', object(HEAD), object(INDEX), RAW)
    const original = observe(capturedInventory([first, second]))
    const reordered = observe(capturedInventory([second, first]))
    const changedIndex = observe(capturedInventory([
      { ...first, index: object('d'.repeat(40)) },
      second,
    ]))
    const changedWorktree = observe(capturedInventory([
      tracked('a.txt', object(HEAD), object(INDEX), 'd'.repeat(40), 'a'.repeat(64)),
      second,
    ]))
    const changedConflictStage = observe(capturedInventory([
      {
        ...conflicted('a.txt'),
        current: first.current,
        stages: [object(HEAD), object('d'.repeat(40)), object(RAW)],
      },
      second,
    ]))
    const renamed = observe(capturedInventory([
      tracked('renamed.txt', object(HEAD), object(INDEX), RAW),
      second,
    ]))

    expect(reordered.index).toEqual(original.index)
    expect(reordered.worktree).toEqual(original.worktree)
    expect(changedIndex.index).not.toEqual(original.index)
    expect(changedIndex.worktree).not.toEqual(original.worktree)
    expect(changedWorktree.index).toEqual(original.index)
    expect(changedWorktree.worktree).not.toEqual(original.worktree)
    expect(changedConflictStage.index.kind).toBe('unmerged')
    expect(changedConflictStage.worktree).not.toEqual(original.worktree)
    expect(renamed.index).not.toEqual(original.index)
    expect(renamed.worktree).not.toEqual(original.worktree)
  })

  it('rejects a Git path that cannot be projected as UTF-8', () => {
    const entry = untracked('placeholder')
    const inventory = capturedInventory([{ ...entry, path: Uint8Array.of(0xff) }])

    expect(() => buildProjectGitStatusObservation(
      inventory,
      selectedInspection(BASELINE),
      { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: BASELINE },
      new AbortController().signal,
      verifiedStatus(inventory),
      BASELINE,
    )).toThrow(new ProjectGitStatusProjectionError('invalid-path'))
  })

  it.each(([
    {
      name: 'inventory comparison drift',
      reason: 'unavailable',
      arrange: () => {
        const original = capturedInventory([untracked('new.txt')])
        return {
          inventory: { ...original, objectFormat: 'sha256' as const },
          inspection: selectedInspection(BASELINE),
          status: verifiedStatus(original),
        }
      },
    },
    {
      name: 'a status path absent from raw inventory',
      reason: 'unavailable',
      arrange: () => ({
        inventory: capturedInventory([]),
        inspection: selectedInspection(BASELINE),
        status: verifiedStatus(capturedInventory([untracked('missing.txt')])),
      }),
    },
    {
      name: 'a directory mode in an ordinary status row',
      reason: 'unavailable',
      arrange: () => {
        const inventory = capturedInventory([tracked('tracked.txt', object(HEAD), object(INDEX), RAW)])
        const status = verifiedStatus(inventory)
        const row = status.entries[0]
        if (row?.kind !== 'ordinary') throw new Error('test inventory produced no ordinary status row')
        return {
          inventory,
          inspection: selectedInspection(BASELINE),
          status: { ...status, entries: [{ ...row, worktreeMode: '040000' as const }] },
        }
      },
    },
    ...(['missing', 'submodule'] as const).map(kind => ({
      name: `an untracked ${kind} worktree`,
      reason: 'unavailable' as const,
      arrange: () => {
        const entry = untracked(`${kind}.txt`)
        const current = kind === 'missing'
          ? {
            kind: 'captured' as const,
            evidence: { kind: 'missing' as const },
            rawByteLength: 0,
            gitEvidenceBytes: 0,
          }
          : {
            kind: 'captured' as const,
            evidence: { kind: 'submodule' as const, objectId: RAW },
            rawObjectId: RAW,
            rawByteLength: 0,
            gitEvidenceBytes: 0,
          }
        const inventory = capturedInventory([{
          ...entry,
          current,
        }])
        return {
          inventory,
          inspection: selectedInspection(BASELINE),
          status: verifiedStatus(inventory),
        }
      },
    })),
    {
      name: 'an attached status without a projected symbolic ref',
      reason: 'unavailable',
      arrange: () => {
        const inventory = capturedInventory([untracked('new.txt')])
        const inspection = selectedInspection(BASELINE)
        return {
          inventory,
          inspection: {
            ...inspection,
            projection: {
              ...inspection.projection,
              head: { kind: 'commit' as const, objectId: HEAD },
            },
          },
          status: verifiedStatus(inventory),
        }
      },
    },
    {
      name: 'an upstream status without a projected upstream ref',
      reason: 'unavailable',
      arrange: () => {
        const inventory = capturedInventory([untracked('new.txt')])
        const status = verifiedStatus(inventory)
        return {
          inventory,
          inspection: selectedInspection(BASELINE),
          status: {
            ...status,
            branch: { ...status.branch, upstream: { name: 'origin/main', ahead: 1 } },
          },
        }
      },
    },
    {
      name: 'a repository-escaping decoded path',
      reason: 'invalid-path',
      arrange: () => {
        const inventory = capturedInventory([untracked('../outside.txt')])
        return {
          inventory,
          inspection: selectedInspection(BASELINE),
          status: verifiedStatus(inventory),
        }
      },
    },
  ] as const))('rejects $name', ({ reason, arrange }) => {
    const { inventory, inspection, status } = arrange()
    expect(() => buildProjectGitStatusObservation(
      inventory,
      inspection,
      { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: BASELINE },
      new AbortController().signal,
      status,
      BASELINE,
    )).toThrow(new ProjectGitStatusProjectionError(reason))
  })

  it('accepts an upstream without divergence counts when its ref is projected', () => {
    const inventory = capturedInventory([untracked('new.txt')])
    const inspection = selectedInspection(BASELINE)
    const status = verifiedStatus(inventory)
    const observation = buildProjectGitStatusObservation(
      inventory,
      { ...inspection, projection: { ...inspection.projection, upstream: 'refs/remotes/origin/main' } },
      { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: BASELINE },
      new AbortController().signal,
      { ...status, branch: { ...status.branch, upstream: { name: 'origin/main', ahead: 1 } } },
      BASELINE,
    )

    expect(observation.upstream).toEqual({
      ref: 'refs/remotes/origin/main', name: 'origin/main',
    })
  })

  it('projects unavailable untracked worktree evidence with an unknown mode', () => {
    const entry = untracked('unavailable.txt')
    const inventory = capturedInventory([{
      ...entry,
      current: { kind: 'unavailable', reason: 'io-failure' },
    }])

    expect(observe(inventory).changes[0]).toMatchObject({
      kind: 'untracked',
      worktreeMode: 'unknown',
      worktreeEvidence: { kind: 'unavailable', reason: 'io-failure' },
    })
  })

  it('rejects duplicate inherited baseline identities and attributes an unavailable baseline', () => {
    const entry = tracked('tracked.txt', object(HEAD), object(INDEX), RAW)
    const inventory = capturedInventory([entry])
    const built = buildInheritedChangeBaseline(
      inventory,
      BASELINE.bounds,
      1,
      new AbortController().signal,
    )
    if (built.baseline.kind !== 'complete') throw new Error('test retained no complete baseline')
    const first = built.baseline.entries[0]
    if (first === undefined) throw new Error('test retained no baseline entry')
    const duplicate = { ...built.baseline, entries: [first, first] }

    expect(() => buildProjectGitStatusObservation(
      inventory,
      selectedInspection(duplicate),
      { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: duplicate },
      new AbortController().signal,
      verifiedStatus(inventory),
      BASELINE,
    )).toThrow(new ProjectGitStatusProjectionError('unavailable'))

    const unavailable: InheritedChangeBaseline = {
      kind: 'unavailable',
      reason: 'io-failure',
      observed: BASELINE.observed,
    }
    const observation = buildProjectGitStatusObservation(
      inventory,
      selectedInspection(BASELINE),
      { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: unavailable },
      new AbortController().signal,
      verifiedStatus(inventory),
      BASELINE,
    )
    expect(observation.changes[0]?.attribution).toBe('unattributed')
  })

  it.each([
    {
      name: 'accepts both exact bounds',
      retainedChanges: MAX_PROJECT_GIT_STATUS_CHANGES - 1,
      nextPathBytes: MAX_PROJECT_GIT_STATUS_PATH_BYTES,
      expected: true,
    },
    {
      name: 'rejects the next row after the row bound',
      retainedChanges: MAX_PROJECT_GIT_STATUS_CHANGES,
      nextPathBytes: 1,
      expected: false,
    },
    {
      name: 'rejects aggregate path-byte overflow',
      retainedChanges: 0,
      nextPathBytes: MAX_PROJECT_GIT_STATUS_PATH_BYTES + 1,
      expected: false,
    },
  ])('$name', ({ retainedChanges, nextPathBytes, expected }) => {
    const assertion = () => { assertProjectGitStatusChangeFits(retainedChanges, nextPathBytes) }
    if (expected) expect(assertion).not.toThrow()
    else expect(assertion).toThrow(new ProjectGitStatusProjectionError('limit'))
  })

  it('keeps conversion and current-evidence uncertainty visible while blocking mutation', () => {
    const gitlink = {
      mode: '160000',
      objectId: HEAD,
    } as const
    const submodule = {
      path: new TextEncoder().encode('module'),
      head: gitlink,
      index: gitlink,
      stages: [undefined, undefined, undefined],
      untracked: false,
      current: {
        kind: 'captured',
        evidence: { kind: 'submodule', objectId: HEAD },
        rawObjectId: HEAD,
        rawByteLength: 0,
        gitEvidenceBytes: 40,
      },
      conversion: { executableFilter: false, unmodeled: false, lineEnding: false },
    } as const satisfies CapturedRepositoryInventoryEntry
    const unavailable = {
      ...tracked('unreadable.txt', object(HEAD), object(HEAD), HEAD),
      current: { kind: 'unavailable', reason: 'io-failure' },
    } as const satisfies CapturedRepositoryInventoryEntry

    const observation = observe(capturedInventory([submodule, unavailable]))

    expect(observation.changes).toHaveLength(1)
    expect(observation.changes[0]).toMatchObject({
      path: 'unreadable.txt',
      kind: 'ordinary',
      indexStatus: 'unchanged',
      worktreeStatus: 'modified',
      attribution: 'unattributed',
      worktreeEvidence: { kind: 'unavailable', reason: 'io-failure' },
    })
    expect(observation.structuredMutation).toEqual({
      available: false,
      blockers: ['conversion-ambiguous', 'current-unavailable'],
    })
    expect(projectGitStatusObservationSchema.parse(observation)).toEqual(observation)
  })

  it('derives every safe Gitlink row from raw inventory while Git ignores nested repositories', async () => {
    const modulePath = new TextEncoder().encode('module')
    const gitlinkHead = gitlink(HEAD)
    const gitlinkIndex = gitlink(INDEX)
    const cases: ReadonlyArray<{
      readonly name: string
      readonly entry: CapturedRepositoryInventoryEntry
      readonly expected: readonly Record<string, unknown>[]
      readonly projection?: 'unavailable'
    }> = [
      {
        name: 'clean initialized',
        entry: rawEntry(gitlinkHead, gitlinkHead, {
          kind: 'captured',
          evidence: { kind: 'submodule', objectId: HEAD },
          rawObjectId: HEAD,
          rawByteLength: 0,
          gitEvidenceBytes: 40,
        }),
        expected: [],
      },
      {
        name: 'current commit changed',
        entry: rawEntry(gitlinkHead, gitlinkHead, {
          kind: 'captured',
          evidence: { kind: 'submodule', objectId: INDEX },
          rawObjectId: INDEX,
          rawByteLength: 0,
          gitEvidenceBytes: 40,
        }),
        expected: [{
          kind: 'ordinary', indexStatus: 'unchanged', worktreeStatus: 'modified', worktreeMode: '160000',
          submodule: { kind: 'submodule', commitChanged: true, trackedChanges: false, untrackedChanges: false },
        }],
      },
      {
        name: 'missing current',
        entry: rawEntry(gitlinkHead, gitlinkHead, {
          kind: 'captured', evidence: { kind: 'missing' }, rawByteLength: 0, gitEvidenceBytes: 0,
        }),
        expected: [{ kind: 'ordinary', indexStatus: 'unchanged', worktreeStatus: 'deleted', worktreeMode: '000000' }],
      },
      {
        name: 'stably present but unavailable current',
        entry: rawEntry(gitlinkHead, gitlinkHead, {
          kind: 'unavailable', reason: 'unsupported-state', observedMode: '160000',
        }),
        expected: [],
        projection: 'unavailable',
      },
      {
        name: 'staged add',
        entry: rawEntry(undefined, gitlinkIndex, {
          kind: 'captured', evidence: { kind: 'missing' }, rawByteLength: 0, gitEvidenceBytes: 0,
        }),
        expected: [{ kind: 'ordinary', indexStatus: 'added', worktreeStatus: 'deleted', worktreeMode: '000000' }],
      },
      {
        name: 'staged delete',
        entry: rawEntry(gitlinkHead, undefined, {
          kind: 'captured',
          evidence: { kind: 'submodule', objectId: HEAD },
          rawObjectId: HEAD,
          rawByteLength: 0,
          gitEvidenceBytes: 40,
        }),
        expected: [{ kind: 'ordinary', indexStatus: 'deleted', worktreeStatus: 'added', worktreeMode: '160000' }],
      },
      {
        name: 'regular to Gitlink type change',
        entry: rawEntry(object(HEAD), gitlinkIndex, {
          kind: 'captured',
          evidence: { kind: 'submodule', objectId: INDEX },
          rawObjectId: INDEX,
          rawByteLength: 0,
          gitEvidenceBytes: 40,
        }),
        expected: [{ kind: 'ordinary', indexStatus: 'type-changed', worktreeStatus: 'unchanged', worktreeMode: '160000' }],
      },
      {
        name: 'Gitlink to regular type change',
        entry: rawEntry(gitlinkHead, object(INDEX), {
          kind: 'captured',
          evidence: { kind: 'regular', mode: '100644', byteLength: 1, contentDigest: 'e'.repeat(64) },
          rawObjectId: INDEX,
          rawByteLength: 1,
          gitEvidenceBytes: 0,
        }),
        expected: [{ kind: 'ordinary', indexStatus: 'type-changed', worktreeStatus: 'unchanged', worktreeMode: '100644' }],
      },
    ]

    for (const fixture of cases) {
      const inventory = capturedInventory([{ ...fixture.entry, path: modulePath }])
      const { status, commands } = await captureStatusEvidence(inventory)
      expect(status.entries, fixture.name).toMatchObject(fixture.expected)
      expect(status.entries, fixture.name).toHaveLength(fixture.expected.length)
      expect(commands[0], fixture.name).toEqual(projectStatusQueryArguments())
      const buildObservation = () => buildProjectGitStatusObservation(
        inventory,
        selectedInspection(BASELINE, inventory.comparison),
        { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: BASELINE },
        new AbortController().signal,
        status,
        BASELINE,
      )
      if (fixture.projection === 'unavailable') {
        expect(buildObservation, fixture.name).toThrow(new ProjectGitStatusProjectionError('unavailable'))
      } else {
        const observation = buildObservation()
        expect(projectGitStatusObservationSchema.parse(observation), fixture.name).toEqual(observation)
        expect(JSON.stringify(observation), fixture.name).not.toContain('observedMode')
        expect(JSON.stringify(observation), fixture.name).not.toContain('trackedChanges')
        expect(JSON.stringify(observation), fixture.name).not.toContain('untrackedChanges')
      }
    }
  })

  it('normalizes raw Gitlink worktree modes to Git comparison semantics', async () => {
    const variants: ReadonlyArray<{
      readonly name: string
      readonly entry: CapturedRepositoryInventoryEntry
      readonly comparison: CapturedRepositoryInventory['comparison']
      readonly expectedIndexStatus: 'added' | 'type-changed'
      readonly expectedMode: '100644' | '120000' | '160000'
    }> = [
      {
        name: 'file mode ignored',
        entry: rawEntry(gitlink(HEAD), object(INDEX), {
          kind: 'captured',
          evidence: { kind: 'regular', mode: '100755', byteLength: 1, contentDigest: 'e'.repeat(64) },
          rawObjectId: INDEX,
          rawByteLength: 1,
          gitEvidenceBytes: 0,
        }),
        comparison: { fileMode: false, symlinks: true, autocrlf: false },
        expectedIndexStatus: 'type-changed',
        expectedMode: '100644',
      },
      {
        name: 'symlinks ignored',
        entry: rawEntry(gitlink(HEAD), { mode: '120000', objectId: INDEX }, {
          kind: 'captured',
          evidence: { kind: 'regular', mode: '100644', byteLength: 1, contentDigest: 'e'.repeat(64) },
          rawObjectId: INDEX,
          rawByteLength: 1,
          gitEvidenceBytes: 0,
        }),
        comparison: { fileMode: true, symlinks: false, autocrlf: false },
        expectedIndexStatus: 'type-changed',
        expectedMode: '120000',
      },
      {
        name: 'skip-worktree',
        entry: {
          ...rawEntry(gitlink(HEAD), object(INDEX), {
            kind: 'captured',
            evidence: { kind: 'regular', mode: '100755', byteLength: 1, contentDigest: 'e'.repeat(64) },
            rawObjectId: RAW,
            rawByteLength: 1,
            gitEvidenceBytes: 0,
          }),
          skipWorktree: true,
        },
        comparison: { fileMode: true, symlinks: true, autocrlf: false },
        expectedIndexStatus: 'type-changed',
        expectedMode: '100644',
      },
      {
        name: 'skip-worktree staged Gitlink add with missing current',
        entry: {
          ...rawEntry(undefined, gitlink(INDEX), {
            kind: 'captured', evidence: { kind: 'missing' }, rawByteLength: 0, gitEvidenceBytes: 0,
          }),
          skipWorktree: true,
        },
        comparison: { fileMode: true, symlinks: true, autocrlf: false },
        expectedIndexStatus: 'added',
        expectedMode: '160000',
      },
      {
        name: 'skip-worktree staged Gitlink type change with missing current',
        entry: {
          ...rawEntry(object(HEAD), gitlink(INDEX), {
            kind: 'captured', evidence: { kind: 'missing' }, rawByteLength: 0, gitEvidenceBytes: 0,
          }),
          skipWorktree: true,
        },
        comparison: { fileMode: true, symlinks: true, autocrlf: false },
        expectedIndexStatus: 'type-changed',
        expectedMode: '160000',
      },
    ]

    for (const variant of variants) {
      const inventory = {
        ...capturedInventory([variant.entry]),
        comparison: variant.comparison,
      }
      const { status } = await captureStatusEvidence(inventory)
      expect(status.entries, variant.name).toMatchObject([{
        kind: 'ordinary',
        indexStatus: variant.expectedIndexStatus,
        worktreeStatus: 'unchanged',
        worktreeMode: variant.expectedMode,
      }])
      const buildObservation = () => buildProjectGitStatusObservation(
        inventory,
        selectedInspection(BASELINE, inventory.comparison),
        { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: BASELINE },
        new AbortController().signal,
        status,
        BASELINE,
        variant.entry.skipWorktree === true,
      )
      if (variant.entry.skipWorktree === true) {
        expect(buildObservation, variant.name).toThrow(new ProjectGitStatusProjectionError('unavailable'))
      } else {
        const observation = buildObservation()
        expect(projectGitStatusObservationSchema.parse(observation), variant.name).toEqual(observation)
      }
    }
  })

  it('keeps unavailable unchanged skip-worktree Gitlink evidence private and relies on the index blocker', async () => {
    const inventory = capturedInventory([{
      ...rawEntry(gitlink(HEAD), gitlink(HEAD), {
        kind: 'unavailable', reason: 'unsupported-state', observedMode: '160000',
      }),
      skipWorktree: true,
    }])
    const { status } = await captureStatusEvidence(inventory)
    expect(status.entries).toEqual([])

    const observation = buildProjectGitStatusObservation(
      inventory,
      selectedInspection(BASELINE, inventory.comparison),
      { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: BASELINE },
      new AbortController().signal,
      status,
      BASELINE,
      true,
    )

    expect(observation.changes).toEqual([])
    expect(observation.structuredMutation).toEqual({ available: false, blockers: ['index-flags'] })
    expect(projectGitStatusObservationSchema.parse(observation)).toEqual(observation)
    expect(JSON.stringify(observation)).not.toContain('observedMode')
  })

  it('keeps current, index, and unmerged mutation blockers in canonical order', () => {
    const inventory = capturedInventory([
      conflicted('conflicted.txt'),
      {
        ...tracked('unavailable.txt', object(HEAD), object(HEAD), HEAD),
        current: { kind: 'unavailable', reason: 'io-failure' },
      },
    ])

    const observation = buildProjectGitStatusObservation(
      inventory,
      selectedInspection(BASELINE, inventory.comparison),
      { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: BASELINE },
      new AbortController().signal,
      verifiedStatus(inventory),
      BASELINE,
      true,
    )

    expect(observation.structuredMutation).toEqual({
      available: false,
      blockers: ['current-unavailable', 'index-flags', 'unmerged'],
    })
    expect(projectGitStatusObservationSchema.parse(observation)).toEqual(observation)
  })

  it('uses raw Gitlink conflict evidence and SHA-256 zero slots without writing an unmerged index tree', async () => {
    const objectId = 'a'.repeat(64)
    const inventory = capturedInventory([rawEntry(
      gitlink(objectId),
      undefined,
      { kind: 'unavailable', reason: 'unsupported-state', observedMode: '160000' },
      [gitlink(objectId), undefined, gitlink('b'.repeat(64))],
    )], 'sha256')

    const { status, commands } = await captureStatusEvidence(inventory)

    expect(status.index).toEqual({ kind: 'unmerged' })
    expect(status.entries).toMatchObject([{
      kind: 'unmerged',
      conflict: 'deleted-by-us',
      worktreeStatus: 'present',
      worktreeMode: '160000',
      ours: { mode: '000000', objectId: '0'.repeat(64) },
      submodule: { kind: 'submodule', trackedChanges: false, untrackedChanges: false },
    }])
    expect(commands).toEqual([projectStatusQueryArguments()])
  })

  it('does not publish hidden HEAD-only Gitlink semantics on an ordinary-file conflict', async () => {
    const inventory = capturedInventory([rawEntry(
      gitlink(HEAD),
      undefined,
      {
        kind: 'captured',
        evidence: { kind: 'regular', mode: '100644', byteLength: 1, contentDigest: 'e'.repeat(64) },
        rawObjectId: RAW,
        rawByteLength: 1,
        gitEvidenceBytes: 0,
      },
      [object(HEAD), object(INDEX), object(RAW)],
    )])
    const { status } = await captureStatusEvidence(inventory)
    expect(status.entries).toMatchObject([{
      kind: 'unmerged',
      submodule: { kind: 'not-submodule' },
      worktreeMode: '100644',
    }])

    const observation = buildProjectGitStatusObservation(
      inventory,
      selectedInspection(BASELINE, inventory.comparison),
      { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: BASELINE },
      new AbortController().signal,
      status,
      BASELINE,
    )
    expect(projectGitStatusObservationSchema.parse(observation)).toEqual(observation)
  })

  it('discards a parsed Gitlink row and rejects a completely unknown current mode at projection', async () => {
    const rawOwned = capturedInventory([rawEntry(gitlink(HEAD), object(INDEX), {
      kind: 'captured',
      evidence: { kind: 'regular', mode: '100644', byteLength: 1, contentDigest: 'e'.repeat(64) },
      rawObjectId: INDEX,
      rawByteLength: 1,
      gitEvidenceBytes: 0,
    })])
    const hostileRow = `1 MM N... 100644 100644 100644 ${'c'.repeat(40)} ${'d'.repeat(40)} module\0`
    const { status } = await captureStatusEvidence(rawOwned, hostileRow)
    expect(status.entries).toMatchObject([{
      kind: 'ordinary',
      indexStatus: 'type-changed',
      worktreeStatus: 'unchanged',
      submodule: { kind: 'submodule' },
      head: { mode: '160000', objectId: HEAD },
      index: { mode: '100644', objectId: INDEX },
    }])

    const unknown = capturedInventory([rawEntry(
      gitlink(HEAD),
      gitlink(HEAD),
      { kind: 'unavailable', reason: 'io-failure' },
    )])
    const captured = await captureStatusEvidence(unknown)
    expect(captured.status.entries).toEqual([])
    expect(() => buildProjectGitStatusObservation(
      unknown,
      selectedInspection(BASELINE),
      { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: BASELINE },
      new AbortController().signal,
      captured.status,
      BASELINE,
    )).toThrow(new ProjectGitStatusProjectionError('unavailable'))
  })

  it.each([
    ['fixed status query', 'status'],
    ['write-tree', 'writeTree'],
  ] as const)('rejects diagnostics from the %s command without retaining them', async (_name, command) => {
    const diagnostic = `private ${command} diagnostic`
    let failure: unknown
    try {
      await captureStatusEvidence(capturedInventory([]), '', {
        [command]: Buffer.from(diagnostic),
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(RepositoryStatusError)
    expect(failure).toMatchObject({
      kind: 'malformed',
      message: 'Saki repository status malformed',
    })
    expect(String(failure)).not.toContain(diagnostic)
    expect(JSON.stringify(failure)).not.toContain(diagnostic)
  })

  it.each([
    {
      name: 'malformed status framing',
      inventory: capturedInventory([]),
      options: { statusStdout: Buffer.from('unsupported\0') },
      kind: 'malformed',
    },
    {
      name: 'an object width that disagrees with the repository',
      inventory: capturedInventory([], 'sha256'),
      options: {
        statusStdout: Buffer.from(`# branch.oid ${HEAD}\0# branch.head main\0`),
        branch: { head: { kind: 'commit', objectId: HEAD, symbolicRef: 'refs/heads/main' } },
      },
      kind: 'malformed',
    },
    {
      name: 'the configured entry bound',
      inventory: capturedInventory([untracked('new.txt')]),
      options: { statusRow: '? new.txt\0', bounds: { maxEntries: 0, maxPathBytes: 10_000 } },
      kind: 'limit',
    },
    {
      name: 'the configured path-byte bound',
      inventory: capturedInventory([untracked('new.txt')]),
      options: { statusRow: '? new.txt\0', bounds: { maxEntries: 100, maxPathBytes: 6 } },
      kind: 'limit',
    },
    {
      name: 'non-UTF-8 write-tree output',
      inventory: capturedInventory([]),
      options: { writeTreeStdout: Buffer.from([0xff, 0x0a]) },
      kind: 'malformed',
    },
    {
      name: 'write-tree output without a line ending',
      inventory: capturedInventory([]),
      options: { writeTreeStdout: Buffer.from('f'.repeat(40)) },
      kind: 'malformed',
    },
    {
      name: 'a malformed write-tree object id',
      inventory: capturedInventory([]),
      options: { writeTreeStdout: Buffer.from(`${'g'.repeat(40)}\n`) },
      kind: 'malformed',
    },
    {
      name: 'a mismatched branch object id',
      inventory: capturedInventory([]),
      options: {
        statusStdout: Buffer.from(`# branch.oid ${'b'.repeat(40)}\0# branch.head main\0`),
      },
      kind: 'malformed',
    },
    {
      name: 'a mismatched attached branch name',
      inventory: capturedInventory([]),
      options: {
        statusStdout: Buffer.from(`# branch.oid ${HEAD}\0# branch.head topic\0`),
      },
      kind: 'malformed',
    },
    {
      name: 'a mismatched upstream name',
      inventory: capturedInventory([]),
      options: {
        statusStdout: Buffer.from(
          `# branch.oid ${HEAD}\0# branch.head main\0# branch.upstream origin/main\0`,
        ),
      },
      kind: 'malformed',
    },
  ] as const)('rejects $name from private status evidence', async ({ inventory, options, kind }) => {
    await expect(captureStatusEvidence(inventory, options.statusRow ?? '', options))
      .rejects.toEqual(new RepositoryStatusError(kind))
  })

  it('accepts independently matched unborn, detached, CRLF, and sorted status facts', async () => {
    const unborn = await captureStatusEvidence(capturedInventory([]), '', {
      statusStdout: Buffer.from('# branch.oid (initial)\0# branch.head topic\0'),
      branch: { head: { kind: 'unborn', symbolicRef: 'refs/heads/topic' } },
      writeTreeStdout: Buffer.from(`${'f'.repeat(40)}\r\n`),
    })
    const detached = await captureStatusEvidence(capturedInventory([]), '', {
      statusStdout: Buffer.from(`# branch.oid ${HEAD}\0# branch.head (detached)\0`),
      branch: { head: { kind: 'commit', objectId: HEAD } },
    })
    const inventory = capturedInventory([untracked('z.txt'), untracked('a.txt')])
    const sorted = await captureStatusEvidence(inventory, '? z.txt\0? a.txt\0')

    expect(unborn.status.branch).toEqual({
      oid: { kind: 'initial' },
      head: { kind: 'attached', name: 'topic' },
    })
    expect(detached.status.branch.head).toEqual({ kind: 'detached' })
    expect(sorted.status.entries.map(entry => Buffer.from(entry.path).toString()))
      .toEqual(['a.txt', 'z.txt'])
  })

  it.each([
    {
      name: 'a status path absent from inventory',
      inventory: capturedInventory([]),
      statusRow: '? absent.txt\0',
    },
    {
      name: 'an omitted unavailable worktree',
      inventory: capturedInventory([{
        ...tracked('unavailable.txt', object(HEAD), object(HEAD), HEAD),
        current: { kind: 'unavailable' as const, reason: 'io-failure' as const },
      }]),
      statusRow: '',
    },
    {
      name: 'an omitted conflict',
      inventory: capturedInventory([conflicted('conflict.txt')]),
      statusRow: '',
    },
    {
      name: 'an omitted untracked path',
      inventory: capturedInventory([untracked('untracked.txt')]),
      statusRow: '',
    },
    {
      name: 'an omitted staged path',
      inventory: capturedInventory([tracked('staged.txt', object(HEAD), object(INDEX), INDEX)]),
      statusRow: '',
    },
  ])('rejects $name from status membership', async ({ inventory, statusRow }) => {
    await expect(captureStatusEvidence(inventory, statusRow))
      .rejects.toEqual(new RepositoryStatusError('ambiguous'))
  })

  it.each([
    {
      name: 'a non-untracked raw entry',
      entry: rawEntry(undefined, undefined, {
        kind: 'captured' as const,
        evidence: { kind: 'missing' as const },
        rawByteLength: 0,
        gitEvidenceBytes: 0,
      }),
    },
    {
      name: 'an untracked entry with a HEAD slot',
      entry: { ...untracked('module'), head: object(HEAD) },
    },
    {
      name: 'an untracked entry with an index slot',
      entry: { ...untracked('module'), index: object(INDEX) },
    },
    {
      name: 'an untracked entry with conflict stages',
      entry: { ...untracked('module'), stages: [object(HEAD), undefined, undefined] as const },
    },
  ])('rejects $name behind an untracked row', async ({ entry }) => {
    await expect(captureStatusEvidence(capturedInventory([entry]), '? module\0'))
      .rejects.toEqual(new RepositoryStatusError('malformed'))
  })

  it.each([
    {
      name: 'an untracked raw entry',
      entry: untracked('ordinary.txt'),
      row: ordinaryStatusRow('ordinary.txt', '.A', undefined, undefined, '100644'),
    },
    {
      name: 'conflict stages',
      entry: conflicted('ordinary.txt'),
      row: ordinaryStatusRow('ordinary.txt', 'MM', object(HEAD), object(INDEX), '100644'),
    },
    {
      name: 'a mismatched HEAD slot',
      entry: tracked('ordinary.txt', object(HEAD), object(INDEX), RAW),
      row: ordinaryStatusRow('ordinary.txt', 'MM', undefined, object(INDEX), '100644'),
    },
    {
      name: 'a mismatched index slot',
      entry: tracked('ordinary.txt', object(HEAD), object(INDEX), RAW),
      row: ordinaryStatusRow('ordinary.txt', 'MM', object(HEAD), object(RAW), '100644'),
    },
    {
      name: 'a mismatched index status',
      entry: tracked('ordinary.txt', object(HEAD), object(INDEX), RAW),
      row: ordinaryStatusRow('ordinary.txt', 'TM', object(HEAD), object(INDEX), '100644'),
    },
  ])('rejects $name behind an ordinary row', async ({ entry, row }) => {
    await expect(captureStatusEvidence(capturedInventory([entry]), row))
      .rejects.toEqual(new RepositoryStatusError('malformed'))
  })

  it.each([
    {
      name: 'a mismatched worktree status',
      row: ordinaryStatusRow('ordinary.txt', 'M.', object(HEAD), object(INDEX), '100644'),
    },
    {
      name: 'a mismatched worktree mode',
      row: ordinaryStatusRow('ordinary.txt', 'MM', object(HEAD), object(INDEX), '100755'),
    },
  ])('rejects $name behind an otherwise matching ordinary row', async ({ row }) => {
    const inventory = capturedInventory([tracked('ordinary.txt', object(HEAD), object(INDEX), RAW)])
    await expect(captureStatusEvidence(inventory, row))
      .rejects.toEqual(new RepositoryStatusError('ambiguous'))
  })

  it('derives Gitlink modes for absent, skipped, unavailable, and unmerged worktrees', async () => {
    const absent = await captureStatusEvidence(capturedInventory([rawEntry(
      gitlink(HEAD),
      undefined,
      { kind: 'captured', evidence: { kind: 'missing' }, rawByteLength: 0, gitEvidenceBytes: 0 },
      [gitlink(HEAD), undefined, gitlink(RAW)],
    )]))
    const skipped = await captureStatusEvidence(capturedInventory([{
      ...rawEntry(gitlink(HEAD), undefined, {
        kind: 'captured',
        evidence: { kind: 'submodule', objectId: HEAD },
        rawObjectId: HEAD,
        rawByteLength: 0,
        gitEvidenceBytes: 40,
      }),
      skipWorktree: true,
    }]))
    const unavailableAdd = await captureStatusEvidence(capturedInventory([rawEntry(
      gitlink(HEAD), undefined, { kind: 'unavailable', reason: 'io-failure', observedMode: '100644' },
    )]))
    const unavailableTypeChange = await captureStatusEvidence(capturedInventory([rawEntry(
      gitlink(HEAD), gitlink(HEAD), { kind: 'unavailable', reason: 'io-failure', observedMode: '100644' },
    )]))
    const ordinaryConflict = await captureStatusEvidence(capturedInventory([rawEntry(
      gitlink(HEAD),
      undefined,
      { kind: 'unavailable', reason: 'io-failure', observedMode: '100644' },
      [object(HEAD), object(INDEX), object(RAW)],
    )]))

    expect(absent.status.entries).toMatchObject([{ kind: 'unmerged', worktreeStatus: 'absent' }])
    expect(skipped.status.entries).toMatchObject([{
      kind: 'ordinary', worktreeStatus: 'unchanged', worktreeMode: '000000',
    }])
    expect(unavailableAdd.status.entries).toMatchObject([{
      kind: 'ordinary', worktreeStatus: 'added', worktreeMode: '100644',
    }])
    expect(unavailableTypeChange.status.entries).toMatchObject([{
      kind: 'ordinary', worktreeStatus: 'type-changed', worktreeMode: '100644',
    }])
    expect(ordinaryConflict.status.entries).toMatchObject([{
      kind: 'unmerged', submodule: { kind: 'not-submodule' },
    }])
  })

  it('rejects an internally contradictory untracked Gitlink inventory entry', async () => {
    const entry = {
      ...rawEntry(gitlink(HEAD), gitlink(HEAD), {
        kind: 'captured' as const,
        evidence: { kind: 'submodule' as const, objectId: HEAD },
        rawObjectId: HEAD,
        rawByteLength: 0,
        gitEvidenceBytes: 40,
      }),
      untracked: true,
    }
    await expect(captureStatusEvidence(capturedInventory([entry])))
      .rejects.toEqual(new RepositoryStatusError('malformed'))
  })

  it('reconstructs assumed symlinks and validates ignored worktree mode differences', async () => {
    const symlink = rawEntry(
      { mode: '120000', objectId: HEAD },
      { mode: '120000', objectId: INDEX },
      {
        kind: 'captured',
        evidence: { kind: 'symlink', targetDigest: 'e'.repeat(64) },
        rawObjectId: RAW,
        rawByteLength: 7,
        gitEvidenceBytes: 0,
      },
    )
    const assumed = await captureStatusEvidence(
      capturedInventory([symlink]),
      '',
      {},
      [new TextEncoder().encode('module')],
    )
    const { index: _deletedIndex, ...deletedWithoutIndex } = tracked(
      'deleted.txt',
      object(HEAD),
      object(HEAD),
      RAW,
    )
    const deletedSkipWorktree = {
      ...deletedWithoutIndex,
      skipWorktree: true,
    }
    const skipped = await captureStatusEvidence(
      capturedInventory([deletedSkipWorktree]),
      ordinaryStatusRow('deleted.txt', 'D.', object(HEAD), undefined, '000000'),
    )
    const modeIgnored = tracked('mode.txt', object(HEAD), object(INDEX), RAW)
    const ignored = await captureStatusEvidence(
      {
        ...capturedInventory([modeIgnored]),
        comparison: { fileMode: false, symlinks: true, autocrlf: false },
      },
      ordinaryStatusRow('mode.txt', 'MM', object(HEAD), object(INDEX), '100755'),
    )
    const symlinkCurrent = {
      ...tracked('link.txt', object(HEAD), object(INDEX), RAW),
      current: {
        kind: 'captured' as const,
        evidence: { kind: 'symlink' as const, targetDigest: 'e'.repeat(64) },
        rawObjectId: RAW,
        rawByteLength: 7,
        gitEvidenceBytes: 0,
      },
    }
    const linked = await captureStatusEvidence(
      capturedInventory([symlinkCurrent]),
      ordinaryStatusRow('link.txt', 'MT', object(HEAD), object(INDEX), '120000'),
    )

    expect(assumed.status.entries).toMatchObject([{
      kind: 'ordinary', worktreeStatus: 'modified', worktreeMode: '120000',
    }])
    expect(skipped.status.entries).toMatchObject([{
      kind: 'ordinary', indexStatus: 'deleted', worktreeStatus: 'unchanged', worktreeMode: '000000',
    }])
    expect(ignored.status.entries).toHaveLength(1)
    expect(linked.status.entries).toMatchObject([{
      kind: 'ordinary', worktreeStatus: 'type-changed', worktreeMode: '120000',
    }])
  })

  it.each([
    ['both-deleted', 'DD', [object(HEAD), undefined, undefined]],
    ['added-by-us', 'AU', [undefined, object(INDEX), undefined]],
    ['deleted-by-them', 'UD', [object(HEAD), object(INDEX), undefined]],
    ['added-by-them', 'UA', [undefined, undefined, object(RAW)]],
    ['deleted-by-us', 'DU', [object(HEAD), undefined, object(RAW)]],
    ['both-added', 'AA', [undefined, object(INDEX), object(RAW)]],
    ['both-modified', 'UU', [object(HEAD), object(INDEX), object(RAW)]],
  ] as const)('accepts the %s conflict mask from matching raw stages', async (conflict, xy, stages) => {
    const entry = rawEntry(undefined, undefined, regularCurrent(RAW), stages)
    const { status } = await captureStatusEvidence(
      capturedInventory([entry]),
      unmergedStatusRow('module', xy, stages, '100644'),
    )
    expect(status.entries).toMatchObject([{ kind: 'unmerged', conflict }])
  })

  it.each([
    {
      name: 'an untracked flag',
      transform: (entry: CapturedRepositoryInventoryEntry) => ({ ...entry, untracked: true }),
      rowStages: [object(HEAD), object(INDEX), object(RAW)] as const,
      xy: 'UU',
    },
    {
      name: 'a stage-zero index slot',
      transform: (entry: CapturedRepositoryInventoryEntry) => ({ ...entry, index: object(INDEX) }),
      rowStages: [object(HEAD), object(INDEX), object(RAW)] as const,
      xy: 'UU',
    },
    {
      name: 'a mismatched base slot',
      transform: (entry: CapturedRepositoryInventoryEntry) => entry,
      rowStages: [object('d'.repeat(40)), object(INDEX), object(RAW)] as const,
      xy: 'UU',
    },
    {
      name: 'a mismatched ours slot',
      transform: (entry: CapturedRepositoryInventoryEntry) => entry,
      rowStages: [object(HEAD), object('d'.repeat(40)), object(RAW)] as const,
      xy: 'UU',
    },
    {
      name: 'a mismatched theirs slot',
      transform: (entry: CapturedRepositoryInventoryEntry) => entry,
      rowStages: [object(HEAD), object(INDEX), object('d'.repeat(40))] as const,
      xy: 'UU',
    },
    {
      name: 'a mismatched conflict class',
      transform: (entry: CapturedRepositoryInventoryEntry) => entry,
      rowStages: [object(HEAD), object(INDEX), object(RAW)] as const,
      xy: 'AA',
    },
  ])('rejects $name behind an unmerged row', async ({ transform, rowStages, xy }) => {
    const rawStages = [object(HEAD), object(INDEX), object(RAW)] as const
    const entry = transform(rawEntry(undefined, undefined, regularCurrent(RAW), rawStages))
    await expect(captureStatusEvidence(
      capturedInventory([entry]),
      unmergedStatusRow('module', xy, rowStages, '100644'),
    )).rejects.toEqual(new RepositoryStatusError('malformed'))
  })

  it.each([
    {
      name: 'a present row for a missing worktree',
      current: {
        kind: 'captured' as const,
        evidence: { kind: 'missing' as const },
        rawByteLength: 0,
        gitEvidenceBytes: 0,
      },
      worktreeMode: '100644' as const,
    },
    {
      name: 'an absent row for a present worktree',
      current: regularCurrent(RAW),
      worktreeMode: '000000' as const,
    },
  ])('rejects $name behind an unmerged row', async ({ current, worktreeMode }) => {
    const stages = [object(HEAD), object(INDEX), object(RAW)] as const
    const entry = rawEntry(undefined, undefined, current, stages)
    await expect(captureStatusEvidence(
      capturedInventory([entry]),
      unmergedStatusRow('module', 'UU', stages, worktreeMode),
    )).rejects.toEqual(new RepositoryStatusError('ambiguous'))
  })

  it('rejects an unmerged submodule declaration without raw Gitlink evidence', async () => {
    const stages = [object(HEAD), object(INDEX), object(RAW)] as const
    const entry = rawEntry(undefined, undefined, regularCurrent(RAW), stages)
    await expect(captureStatusEvidence(
      capturedInventory([entry]),
      unmergedStatusRow('module', 'UU', stages, '100644', 'S...'),
    )).rejects.toEqual(new RepositoryStatusError('malformed'))
  })

  it('rejects an unmerged row when raw inventory has no conflict stages', async () => {
    const stages = [undefined, undefined, undefined] as const
    const entry = rawEntry(undefined, undefined, regularCurrent(RAW), stages)
    await expect(captureStatusEvidence(
      capturedInventory([entry]),
      unmergedStatusRow('module', 'DD', stages, '100644'),
    )).rejects.toEqual(new RepositoryStatusError('malformed'))
  })

  it('fails closed when the index-flag query omits known stage-zero membership', async () => {
    const inventory = capturedInventory([tracked('tracked.txt', object(HEAD), object(INDEX), RAW)])
    await expect(captureIndexFlagEvidence(inventory, Buffer.alloc(0)))
      .resolves.toMatchObject({ mutationBlocked: true, assumeUnchangedPaths: [] })
  })

  it('accepts an empty flag listing when inventory has no index entries', async () => {
    const inventory = capturedInventory([untracked('untracked.txt')])
    await expect(captureIndexFlagEvidence(inventory, Buffer.alloc(0))).resolves.toMatchObject({
      mutationBlocked: false,
      assumeUnchangedPaths: [],
    })
  })

  it('blocks a lowercase Gitlink flag without granting ordinary-file reconstruction authority', async () => {
    const entry = rawEntry(gitlink(HEAD), gitlink(HEAD), {
      kind: 'captured',
      evidence: { kind: 'submodule', objectId: HEAD },
      rawObjectId: HEAD,
      rawByteLength: 0,
      gitEvidenceBytes: 40,
    })
    const inventory = capturedInventory([entry])

    await expect(captureIndexFlagEvidence(inventory, Buffer.from('h module\0'))).resolves.toMatchObject({
      mutationBlocked: true,
      assumeUnchangedPaths: [],
    })
  })

  it('retains only exact ordinary assume-unchanged paths from complete index-flag membership', async () => {
    const assumed = tracked('assumed.txt', object(HEAD), object(HEAD), RAW)
    const ordinary = tracked('ordinary.txt', object(HEAD), object(HEAD), HEAD)
    const skipped = { ...tracked('skipped.txt', object(HEAD), object(HEAD), HEAD), skipWorktree: true }
    const conflict = conflicted('conflict.txt')
    const inventory = capturedInventory([ordinary, conflict, skipped, assumed])
    const stdout = Buffer.from([
      'h assumed.txt\0',
      'M conflict.txt\0', 'M conflict.txt\0', 'M conflict.txt\0',
      'H ordinary.txt\0',
      'S skipped.txt\0',
    ].join(''))
    const evidence = await captureIndexFlagEvidence(inventory, stdout)

    expect(evidence.mutationBlocked).toBe(true)
    expect(evidence.assumeUnchangedPaths.map(path => Buffer.from(path).toString())).toEqual(['assumed.txt'])
    expect(evidence.identity).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('keeps lowercase skip and conflicted flags out of the assume-unchanged allowlist', async () => {
    const skipped = { ...tracked('skipped.txt', object(HEAD), object(HEAD), HEAD), skipWorktree: true }
    const conflict = conflicted('conflict.txt')
    const inventory = capturedInventory([skipped, conflict])
    await expect(captureIndexFlagEvidence(
      inventory,
      Buffer.from('s skipped.txt\0m conflict.txt\0M conflict.txt\0M conflict.txt\0'),
    )).resolves.toMatchObject({ mutationBlocked: true, assumeUnchangedPaths: [] })
  })

  it('clears partial assume-unchanged authority when index-flag membership is anomalous', async () => {
    const inventory = capturedInventory([
      tracked('assumed.txt', object(HEAD), object(HEAD), RAW),
      tracked('missing.txt', object(HEAD), object(HEAD), HEAD),
    ])
    await expect(captureIndexFlagEvidence(inventory, Buffer.from('h assumed.txt\0')))
      .resolves.toMatchObject({ mutationBlocked: true, assumeUnchangedPaths: [] })
  })

  it.each([
    ['duplicates stage-zero membership', Buffer.from('H tracked.txt\0H tracked.txt\0')],
    ['reports an extra path', Buffer.from('H tracked.txt\0H extra.txt\0')],
    ['uses a stage-zero tag that disagrees with inventory', Buffer.from('S tracked.txt\0')],
  ])('blocks mutation and clears partial authority when Git %s', async (_name, stdout) => {
    const inventory = capturedInventory([tracked('tracked.txt', object(HEAD), object(HEAD), HEAD)])
    await expect(captureIndexFlagEvidence(inventory, stdout))
      .resolves.toMatchObject({ mutationBlocked: true, assumeUnchangedPaths: [] })
  })

  it('retains exact non-UTF-8 assume paths in byte order and identities every flag change', async () => {
    const firstPath = Uint8Array.of(0xff)
    const secondPath = new TextEncoder().encode('a')
    const first = { ...tracked('unused', object(HEAD), object(HEAD), RAW), path: firstPath }
    const second = { ...tracked('unused', object(HEAD), object(HEAD), RAW), path: secondPath }
    const inventory = capturedInventory([first, second])
    const lowercase = Buffer.concat([
      Buffer.from('h '), Buffer.from(firstPath), Buffer.from([0]),
      Buffer.from('h '), Buffer.from(secondPath), Buffer.from([0]),
    ])
    const evidence = await captureIndexFlagEvidence(inventory, lowercase)
    const uppercase = await captureIndexFlagEvidence(
      inventory,
      Buffer.concat([
        Buffer.from('H '), Buffer.from(firstPath), Buffer.from([0]),
        Buffer.from('H '), Buffer.from(secondPath), Buffer.from([0]),
      ]),
    )
    const sparse = await captureIndexFlagEvidence(inventory, lowercase, { sparseIndexEnabled: true })

    expect(evidence.assumeUnchangedPaths.map(path => [...path])).toEqual([[...secondPath], [...firstPath]])
    expect(new Set([evidence.identity, uppercase.identity, sparse.identity]).size).toBe(3)
  })

  it.each([
    ['diagnostics', Buffer.from('H tracked.txt\0'), Buffer.from('private diagnostic'), 'unavailable'],
    ['unterminated output', Buffer.from('H tracked.txt'), Buffer.alloc(0), 'malformed'],
    ['a short record', Buffer.from('H\0'), Buffer.alloc(0), 'malformed'],
    ['a missing tag separator', Buffer.from('H!tracked.txt\0'), Buffer.alloc(0), 'malformed'],
    ['an unknown tag', Buffer.from('X tracked.txt\0'), Buffer.alloc(0), 'malformed'],
  ] as const)('rejects %s from the index-flag query', async (_name, stdout, stderr, kind) => {
    const inventory = capturedInventory([tracked('tracked.txt', object(HEAD), object(HEAD), HEAD)])
    await expect(captureIndexFlagEvidence(inventory, stdout, { stderr }))
      .rejects.toEqual(new RepositoryInventoryError(kind))
  })

  it('reconstructs an exact hidden ordinary row without forgiving another missing status row', async () => {
    const assumed = tracked('assumed.txt', object(HEAD), object(HEAD), RAW)
    const unflagged = tracked('unflagged.txt', object(HEAD), object(HEAD), RAW)
    const assumePath = new TextEncoder().encode('assumed.txt')
    const { status } = await captureStatusEvidence(
      capturedInventory([assumed]),
      '',
      {},
      [assumePath],
    )
    expect(status.entries).toMatchObject([{
      kind: 'ordinary',
      indexStatus: 'unchanged',
      worktreeStatus: 'modified',
    }])

    await expect(captureStatusEvidence(
      capturedInventory([assumed, unflagged]),
      '',
      {},
      [assumePath],
    )).rejects.toEqual(new RepositoryStatusError('ambiguous'))
  })

  it('reconstructs both staged and hidden worktree changes for one assume-unchanged path', async () => {
    const entry = tracked('assumed.txt', object(HEAD), object(INDEX), RAW)
    const { status } = await captureStatusEvidence(
      capturedInventory([entry]),
      '',
      {},
      [new TextEncoder().encode('assumed.txt')],
    )

    expect(status.entries).toMatchObject([{
      kind: 'ordinary',
      indexStatus: 'modified',
      worktreeStatus: 'modified',
      head: object(HEAD),
      index: object(INDEX),
    }])
  })

  it('omits a clean assumed path and retains the index mode for a staged-only path', async () => {
    const clean = tracked('clean.txt', object(HEAD), object(HEAD), HEAD)
    const staged = tracked('staged.txt', object(HEAD), object(INDEX), INDEX)
    const inventory = capturedInventory([clean, staged])
    const { status } = await captureStatusEvidence(
      inventory,
      '',
      {},
      [new TextEncoder().encode('clean.txt'), new TextEncoder().encode('staged.txt')],
    )

    expect(status.entries).toMatchObject([{
      kind: 'ordinary',
      path: new TextEncoder().encode('staged.txt'),
      indexStatus: 'modified',
      worktreeStatus: 'unchanged',
      worktreeMode: '100644',
    }])
  })

  it.each([
    ['an unknown path', [new TextEncoder().encode('unknown.txt')]],
    ['a duplicate path', [
      new TextEncoder().encode('tracked.txt'),
      new TextEncoder().encode('tracked.txt'),
    ]],
  ])('rejects %s in assume-unchanged reconstruction authority', async (_name, paths) => {
    const inventory = capturedInventory([tracked('tracked.txt', object(HEAD), object(HEAD), HEAD)])
    await expect(captureStatusEvidence(inventory, '', {}, paths))
      .rejects.toEqual(new RepositoryStatusError('ambiguous'))
  })

  it.each([
    ['unavailable current evidence', {
      ...tracked('tracked.txt', object(HEAD), object(HEAD), RAW),
      current: { kind: 'unavailable' as const, reason: 'io-failure' as const },
    }],
    ['ambiguous conversion evidence', {
      ...tracked('tracked.txt', object(HEAD), object(HEAD), RAW),
      conversion: { executableFilter: true, unmodeled: false, lineEnding: false },
    }],
  ])('rejects hidden ordinary status with %s', async (_name, entry) => {
    await expect(captureStatusEvidence(
      capturedInventory([entry]),
      '',
      {},
      [new TextEncoder().encode('tracked.txt')],
    )).rejects.toEqual(new RepositoryStatusError('ambiguous'))
  })

  it('keeps a verified potential intent-to-add row instead of guessing from its empty-blob index', async () => {
    const emptyBlob = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
    const { head: _head, ...withoutHead } = tracked('intent.txt', object(HEAD), object(HEAD), RAW)
    const entry: CapturedRepositoryInventoryEntry = {
      ...withoutHead,
      index: object(emptyBlob),
    }
    const zero = '0'.repeat(40)
    const row = `1 .A N... 000000 000000 100644 ${zero} ${zero} intent.txt\0`
    const { status } = await captureStatusEvidence(
      capturedInventory([entry]),
      row,
      {},
      [new TextEncoder().encode('intent.txt')],
    )

    expect(status.entries).toMatchObject([{
      kind: 'ordinary',
      indexStatus: 'unchanged',
      worktreeStatus: 'added',
    }])
  })
})

async function captureIndexFlagEvidence(
  inventory: CapturedRepositoryInventory,
  stdout: Buffer,
  options: {
    readonly stderr?: Buffer
    readonly sparseIndexEnabled?: boolean
  } = {},
) {
  const git: RepositoryInventoryGit = {
    async run() { return { stdout, stderr: options.stderr ?? Buffer.alloc(0) } },
  }
  return await captureRepositoryIndexFlagEvidence(
    git,
    'repository',
    new AbortController().signal,
    inventory,
    options.sparseIndexEnabled ?? false,
  )
}

async function captureStatusEvidence(
  inventory: CapturedRepositoryInventory,
  statusRow = '',
  options: Readonly<{
    status?: Buffer
    writeTree?: Buffer
    statusStdout?: Buffer
    writeTreeStdout?: Buffer
    branch?: RepositoryStatusBranchExpectation
    bounds?: RepositoryStatusBounds
    signal?: AbortSignal
  }> = {},
  assumeUnchangedPaths: readonly Uint8Array[] = [],
): Promise<{ readonly status: VerifiedRepositoryStatus; readonly commands: readonly (readonly string[])[] }> {
  const width = inventory.objectFormat === 'sha1' ? 40 : 64
  const head = 'a'.repeat(width)
  const commands: string[][] = []
  const git: RepositoryInventoryGit = {
    async run(_cwd, args) {
      commands.push([...args])
      if (args.length === projectStatusQueryArguments().length
        && args.every((value, index) => value === projectStatusQueryArguments()[index])) {
        return {
          stdout: options.statusStdout ?? Buffer.from(`# branch.oid ${head}\0# branch.head main\0${statusRow}`),
          stderr: options.status ?? Buffer.alloc(0),
        }
      }
      if (args.length === 1 && args[0] === 'write-tree') {
        return {
          stdout: options.writeTreeStdout ?? Buffer.from(`${'f'.repeat(width)}\n`),
          stderr: options.writeTree ?? Buffer.alloc(0),
        }
      }
      throw new Error(`unexpected Git status evidence command: ${args.join(' ')}`)
    },
  }
  const status = await captureVerifiedRepositoryStatus(
    git,
    'repository',
    inventory.objectFormat,
    options.branch ?? { head: { kind: 'commit', objectId: head, symbolicRef: 'refs/heads/main' } },
    inventory,
    options.bounds ?? { maxEntries: 100, maxPathBytes: 10_000 },
    options.signal ?? new AbortController().signal,
    assumeUnchangedPaths,
  )
  return { status, commands }
}

function ordinaryStatusRow(
  path: string,
  xy: string,
  head: CapturedInventoryGitObject | undefined,
  index: CapturedInventoryGitObject | undefined,
  worktreeMode: '000000' | '100644' | '100755' | '120000' | '160000',
  submodule = 'N...',
): string {
  const zero = '0'.repeat(40)
  return `1 ${xy} ${submodule} ${head?.mode ?? '000000'} ${index?.mode ?? '000000'} ${worktreeMode} ${head?.objectId ?? zero} ${index?.objectId ?? zero} ${path}\0`
}

function unmergedStatusRow(
  path: string,
  xy: string,
  stages: readonly [
    CapturedInventoryGitObject | undefined,
    CapturedInventoryGitObject | undefined,
    CapturedInventoryGitObject | undefined,
  ],
  worktreeMode: '000000' | '100644' | '100755' | '120000' | '160000',
  submodule = 'N...',
): string {
  const zero = '0'.repeat(40)
  const slots = stages.map(stage => ({
    mode: stage?.mode ?? '000000',
    objectId: stage?.objectId ?? zero,
  }))
  return `u ${xy} ${submodule} ${slots[0]!.mode} ${slots[1]!.mode} ${slots[2]!.mode} ${worktreeMode} ${slots[0]!.objectId} ${slots[1]!.objectId} ${slots[2]!.objectId} ${path}\0`
}

function regularCurrent(rawObjectId: string): Extract<
  CapturedRepositoryInventoryEntry['current'],
  { readonly kind: 'captured' }
> {
  return {
    kind: 'captured',
    evidence: { kind: 'regular', mode: '100644', byteLength: 7, contentDigest: 'e'.repeat(64) },
    rawObjectId,
    rawByteLength: 7,
    gitEvidenceBytes: 0,
  }
}

function rawEntry(
  head: CapturedInventoryGitObject | undefined,
  index: CapturedInventoryGitObject | undefined,
  current: CapturedRepositoryInventoryEntry['current'],
  stages: CapturedRepositoryInventoryEntry['stages'] = [undefined, undefined, undefined],
): CapturedRepositoryInventoryEntry {
  return {
    path: new TextEncoder().encode('module'),
    ...(head === undefined ? {} : { head }),
    ...(index === undefined ? {} : { index }),
    stages,
    untracked: false,
    current,
    conversion: { executableFilter: false, unmodeled: false, lineEnding: false },
  }
}

function gitlink(objectId: string): CapturedInventoryGitObject {
  return { mode: '160000', objectId }
}

function observe(inventory: CapturedRepositoryInventory) {
  return buildProjectGitStatusObservation(
    inventory,
    selectedInspection(BASELINE),
    { id: BINDING_ID, revision: 3, health: 'active', inheritedChangeBaseline: BASELINE },
    new AbortController().signal,
    verifiedStatus(inventory),
    BASELINE,
  )
}

function verifiedStatus(inventory: CapturedRepositoryInventory): VerifiedRepositoryStatus {
  const entries = inventory.entries
    .flatMap(entry => projectStatusEntry(entry))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  const unmerged = entries.some(entry => entry.kind === 'unmerged')
  const treeMaterial = [...inventory.entries]
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
    .map(entry => ({
      path: Buffer.from(entry.path).toString('hex'),
      index: entry.index,
      stages: entry.stages,
    }))
  return {
    branch: {
      oid: { kind: 'commit', objectId: HEAD },
      head: { kind: 'attached', name: 'main' },
    },
    objectIdWidth: 40,
    entries,
    index: unmerged
      ? { kind: 'unmerged' }
      : { kind: 'tree', treeId: createHash('sha1').update(JSON.stringify(treeMaterial)).digest('hex') },
  }
}

function projectStatusEntry(entry: CapturedRepositoryInventoryEntry): readonly ParsedStatusEntry[] {
  if (entry.untracked) return [{
    kind: 'untracked',
    path: entry.path,
    indexStatus: 'absent',
    worktreeStatus: 'untracked',
    submodule: { kind: 'not-submodule' },
  }]
  if (entry.stages.some(stage => stage !== undefined)) {
    const slots = entry.stages.map(stage => stage ?? { mode: '000000' as const, objectId: '0'.repeat(40) })
    const worktreeMode = inventoryWorktreeMode(entry, entry.index?.mode ?? '100644')
    return [{
      kind: 'unmerged',
      path: entry.path,
      indexStatus: 'unmerged',
      worktreeStatus: worktreeMode === '000000' ? 'absent' : 'present',
      conflict: conflictFor(entry),
      submodule: submoduleFor(entry),
      base: slots[0]!,
      ours: slots[1]!,
      theirs: slots[2]!,
      worktreeMode,
    }]
  }
  const head = entry.head ?? { mode: '000000' as const, objectId: '0'.repeat(40) }
  const index = entry.index ?? { mode: '000000' as const, objectId: '0'.repeat(40) }
  const indexStatus = entry.head === undefined
    ? 'added' as const
    : entry.index === undefined
      ? 'deleted' as const
      : modeKind(entry.head.mode) !== modeKind(entry.index.mode)
        ? 'type-changed' as const
        : entry.head.mode === entry.index.mode && entry.head.objectId === entry.index.objectId
          ? 'unchanged' as const
          : 'modified' as const
  const worktreeMode = inventoryWorktreeMode(entry, entry.index?.mode ?? '100644')
  const worktreeStatus = entry.current.kind === 'unavailable'
    ? 'modified' as const
    : entry.current.evidence.kind === 'missing'
      ? entry.index === undefined ? 'unchanged' as const : 'deleted' as const
      : entry.index === undefined
        ? 'added' as const
        : modeKind(entry.index.mode) !== modeKind(worktreeMode)
          ? 'type-changed' as const
          : entry.current.rawObjectId === entry.index.objectId
              && (entry.current.evidence.kind !== 'regular'
                || entry.current.evidence.mode === entry.index.mode)
            ? 'unchanged' as const
            : 'modified' as const
  if (indexStatus === 'unchanged' && worktreeStatus === 'unchanged') return []
  return [{
    kind: 'ordinary',
    path: entry.path,
    indexStatus,
    worktreeStatus,
    submodule: submoduleFor(entry),
    head,
    index,
    worktreeMode,
  }]
}

function inventoryWorktreeMode(
  entry: CapturedRepositoryInventoryEntry,
  unavailableFallback: CapturedInventoryGitObject['mode'],
): '000000' | '100644' | '100755' | '120000' | '160000' {
  if (entry.current.kind === 'unavailable') return unavailableFallback
  switch (entry.current.evidence.kind) {
    case 'missing': return '000000'
    case 'regular': return entry.current.evidence.mode
    case 'symlink': return '120000'
    case 'submodule': return '160000'
  }
}

function modeKind(mode: CapturedInventoryGitObject['mode'] | '000000'):
'missing' | 'regular' | 'symlink' | 'submodule' {
  if (mode === '000000') return 'missing'
  if (mode === '120000') return 'symlink'
  if (mode === '160000') return 'submodule'
  return 'regular'
}

function submoduleFor(entry: CapturedRepositoryInventoryEntry) {
  const gitlink = entry.head?.mode === '160000' || entry.index?.mode === '160000'
    || entry.stages.some(stage => stage?.mode === '160000')
    || (entry.current.kind === 'captured' && entry.current.evidence.kind === 'submodule')
  if (!gitlink) return { kind: 'not-submodule' as const }
  const commitChanged: boolean | 'unknown' = entry.index?.mode === '160000'
    && entry.current.kind === 'captured' && entry.current.evidence.kind === 'submodule'
    ? entry.index.objectId !== entry.current.evidence.objectId
    : 'unknown'
  return { kind: 'submodule' as const, commitChanged, trackedChanges: false, untrackedChanges: false }
}

function conflictFor(entry: CapturedRepositoryInventoryEntry): Extract<
  ParsedStatusEntry,
  { readonly kind: 'unmerged' }
>['conflict'] {
  const mask = entry.stages.map(stage => stage === undefined ? '0' : '1').join('')
  switch (mask) {
    case '100': return 'both-deleted'
    case '010': return 'added-by-us'
    case '110': return 'deleted-by-them'
    case '001': return 'added-by-them'
    case '101': return 'deleted-by-us'
    case '011': return 'both-added'
    case '111': return 'both-modified'
    default: throw new Error('test inventory lacks a valid conflict stage mask')
  }
}

function capturedInventory(
  entries: readonly CapturedRepositoryInventoryEntry[],
  objectFormat: CapturedRepositoryInventory['objectFormat'] = 'sha1',
): CapturedRepositoryInventory {
  return {
    objectFormat,
    comparison: { fileMode: true, symlinks: true, autocrlf: false },
    allowlistedGitEvidenceBytes: 0,
    capture: {
      elapsedMs: 1,
      rawBytes: entries.reduce((total, entry) => total
        + (entry.current.kind === 'captured' ? entry.current.rawByteLength : 0), 0),
    },
    entries,
  }
}

function tracked(
  path: string,
  head: CapturedInventoryGitObject,
  index: CapturedInventoryGitObject,
  rawObjectId: string,
  contentDigest = 'e'.repeat(64),
): CapturedRepositoryInventoryEntry {
  return {
    path: new TextEncoder().encode(path),
    head,
    index,
    stages: [undefined, undefined, undefined],
    untracked: false,
    current: {
      kind: 'captured',
      evidence: { kind: 'regular', mode: '100644', byteLength: 7, contentDigest },
      rawObjectId,
      rawByteLength: 7,
      gitEvidenceBytes: 0,
    },
    conversion: { executableFilter: false, unmodeled: false, lineEnding: false },
  }
}

function conflicted(path: string): CapturedRepositoryInventoryEntry {
  return {
    path: new TextEncoder().encode(path),
    head: object(HEAD),
    stages: [object(HEAD), object(INDEX), object(RAW)],
    untracked: false,
    current: {
      kind: 'captured',
      evidence: { kind: 'regular', mode: '100644', byteLength: 12, contentDigest: '9'.repeat(64) },
      rawObjectId: '9'.repeat(40),
      rawByteLength: 12,
      gitEvidenceBytes: 0,
    },
    conversion: { executableFilter: false, unmodeled: false, lineEnding: false },
  }
}

function untracked(path: string): CapturedRepositoryInventoryEntry {
  return {
    path: new TextEncoder().encode(path),
    stages: [undefined, undefined, undefined],
    untracked: true,
    current: {
      kind: 'captured',
      evidence: { kind: 'regular', mode: '100644', byteLength: 3, contentDigest: 'f'.repeat(64) },
      rawObjectId: 'f'.repeat(40),
      rawByteLength: 3,
      gitEvidenceBytes: 0,
    },
    conversion: { executableFilter: false, unmodeled: false, lineEnding: false },
  }
}

function object(objectId: string): CapturedInventoryGitObject {
  return { mode: '100644', objectId }
}

function selectedInspection(
  baseline: InheritedChangeBaseline,
  comparison: CapturedRepositoryInventory['comparison'] = {
    fileMode: true,
    symlinks: true,
    autocrlf: false,
  },
): ProjectSelectionInspection {
  return {
    projection: {
      observationVersion: 2,
      hostId: HOST_ID,
      displayLocation: 'repository',
      objectFormat: 'sha1',
      head: { kind: 'commit', objectId: HEAD, symbolicRef: 'refs/heads/main' },
      locked: false,
      inheritedChangeEntryCount: 0,
      conversionAmbiguous: false,
      remotes: [],
      automaticMutationEligible: true,
      blockingReasons: [],
      baseline,
      fingerprint: { version: 2, digest: '1'.repeat(64) },
    },
    trusted: {
      canonicalWorktreePath: 'C:\\private\\repository',
      canonicalGitDirectory: 'C:\\private\\repository\\.git',
      canonicalCommonGitDirectory: 'C:\\private\\repository\\.git',
      gitDirectoryIdentity: { version: 1, digest: '2'.repeat(64) },
      commonGitDirectoryIdentity: { version: 1, digest: '2'.repeat(64) },
      comparison,
    },
  }
}
