import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  computeProjectGitChangeFingerprint,
  MAX_PROJECT_GIT_DIFF_CURSOR_CHARS,
  MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES,
  MAX_PROJECT_GIT_DIFF_PAGE_LINES,
  MAX_PROJECT_GIT_DIFF_PAGE_UTF8_BYTES,
  MAX_PROJECT_GIT_DIFF_TOTAL_LINES,
  MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES,
} from '@breakfastdapaidang/saki-execution'
import type {
  ActiveHostProjectBinding,
  InheritedChangeBaseline,
  ProjectGitChange,
  ProjectGitChangeId,
  ProjectGitDiffCursor,
  ProjectGitStatusObservation,
  ProjectSelectionInspection,
  SakiHostId,
  SakiResourceBindingId,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it } from 'vitest'
import {
  completeProjectDiffPage,
  parseProjectDiffBinaryPreflight,
  parseProjectDiffPatch,
  projectDiffAdministrativeIdentityFailure,
  projectDiffCommandFits,
  projectDiffRepositoryOpenFailureReason,
  projectDiffSelectionFailureReason,
  readLocalProjectDiff,
  readStablePatch,
  resolveProjectDiffTarget,
  observeBoundProject,
  type BoundProjectObservation,
  type DiffCursorMaterial,
  type LocalProjectDiffDependencies,
  type LocalProjectDiffInternals,
} from '../src/diff.ts'
import { isSafeProjectDiffQuery, projectDiffQueryArguments } from '../src/diff-query.ts'
import { GitCommandError, GitRunner, gitInspectionEnvironment, type RawOutputBudget } from '../src/git-runner.ts'
import { BoundProjectResourceMismatchError } from '../src/inspection.ts'
import { LocalSakiHostExecution, type Config } from '../src/index.ts'
import { RepositoryControlChangedError, type SafeRepositoryView } from '../src/safe-repository.ts'
import { ProjectGitStatusProjectionError } from '../src/status.ts'
import type { CapturedRepositoryInventory, CapturedRepositoryInventoryEntry } from '../src/baseline.ts'
import type { VerifiedRepositoryStatus } from '../src/status-evidence.ts'
import { mountLocalHostOperationStorage } from './storage.ts'

const run = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
const BINDING_ID = 'binding-11111111-1111-4111-8111-111111111111' as SakiResourceBindingId
const WORKSPACE_ID = WorkspaceId('workspace-diff')
const CONFIG: Omit<Required<Config>, 'pushCredentialHelper'> = {
  gitCommandTimeoutMs: 10_000,
  gitTerminationGraceMs: 100,
  maxGitStdoutBytes: 20 * 1024 * 1024,
  maxGitStderrBytes: 64 * 1024,
  inventoryMaxEntries: 10_000,
  inventoryMaxPathBytes: 1024 * 1024,
  inventoryMaxGitOutputBytes: 4 * 1024 * 1024,
  inventoryMaxFileBytes: 1024 * 1024,
  inventoryMaxTotalFileBytes: 8 * 1024 * 1024,
  inventoryMaxCaptureMs: 10_000,
  baselineMaxEntries: 1_000,
  baselineMaxPathBytes: 1024 * 1024,
  baselineMaxGitOutputBytes: 4 * 1024 * 1024,
  baselineMaxFileBytes: 1024 * 1024,
  baselineMaxTotalFileBytes: 4 * 1024 * 1024,
  baselineMaxCaptureMs: 10_000,
  operationMaxIndexBytes: 8 * 1024 * 1024,
  operationMaxReflogBytes: 1024 * 1024,
}

const REAL_GIT_DIFF_TEST_TIMEOUT_MS = 90_000

describe('project Diff query grammar', () => {
  const sha1 = '1'.repeat(40)
  const sha256 = '2'.repeat(64)
  const unborn = { kind: 'unborn', symbolicRef: 'refs/heads/main' } as const

  it('accepts only exact constructible queries for each output, layer, and object format', () => {
    for (const kind of ['binary-preflight', 'patch'] as const) {
      const unstaged = projectDiffQueryArguments(kind, 'literal path.txt', 'unstaged', unborn)
      const stagedUnborn = projectDiffQueryArguments(kind, 'literal path.txt', 'staged', unborn)
      const stagedSha1 = projectDiffQueryArguments(kind, 'literal path.txt', 'staged', {
        kind: 'commit',
        objectId: sha1,
      })
      const stagedSha256 = projectDiffQueryArguments(kind, 'literal path.txt', 'staged', {
        kind: 'commit',
        objectId: sha256,
      })

      expect(isSafeProjectDiffQuery(unstaged, 'sha1')).toBe(true)
      expect(isSafeProjectDiffQuery(stagedUnborn, 'sha1')).toBe(true)
      expect(isSafeProjectDiffQuery(stagedSha1, 'sha1')).toBe(true)
      expect(isSafeProjectDiffQuery(stagedSha256, 'sha256')).toBe(true)
      expect(isSafeProjectDiffQuery(stagedSha1, 'sha256')).toBe(false)
      expect(isSafeProjectDiffQuery([...stagedSha1.slice(0, -3), '0'.repeat(40), '--', 'literal path.txt'], 'sha1'))
        .toBe(false)
      expect(isSafeProjectDiffQuery([...unstaged, '--unexpected-option'], 'sha1')).toBe(false)
    }
  })

  it('rejects missing and unsafe final paths before considering a query', () => {
    expect(isSafeProjectDiffQuery([], 'sha1')).toBe(false)
    expect(isSafeProjectDiffQuery(['--literal-pathspecs', 'diff', '--', '../outside'], 'sha1')).toBe(false)
    expect(isSafeProjectDiffQuery(['literal.txt'], 'sha1')).toBe(false)
  })
})

describe('project Diff cursor grammar', () => {
  const digest = 'a'.repeat(64)
  const changeId = `git-change-${'b'.repeat(64)}` as ProjectGitChangeId
  const dependencies = new Proxy({}, {
    get() {
      throw new Error('malformed and stale cursors must not observe repository dependencies')
    },
  }) as LocalProjectDiffDependencies
  const binding = {} as ActiveHostProjectBinding
  const signal = new AbortController().signal

  it.each([
    ['empty', ''],
    ['oversized', 'x'.repeat(MAX_PROJECT_GIT_DIFF_CURSOR_CHARS + 1)],
    ['invalid alphabet', 'not-base64url!'],
    ['non-canonical base64url', 'A'],
    ['invalid JSON', Buffer.from('{', 'utf8').toString('base64url')],
    ['invalid UTF-8', Buffer.from([0xff]).toString('base64url')],
  ])('rejects a %s cursor before repository observation', async (_case, cursor) => {
    await expect(readLocalProjectDiff(dependencies, binding, {
      expectedStatus: { version: 1, digest },
      changeId,
      layer: 'unstaged',
      cursor: cursor as ProjectGitDiffCursor,
    }, signal)).resolves.toEqual({ ok: false, reason: 'invalid-cursor' })
  })

  it.each([
    ['primitive', 'value'],
    ['null', null],
    ['array', []],
    ['wrong field count', { version: 1 }],
    ['wrong first field', orderedCursorMaterial({ firstKey: 'schemaVersion' })],
    ['wrong observation field', orderedCursorMaterial({ observationKey: 'statusDigest' })],
    ['wrong change field', orderedCursorMaterial({ changeKey: 'pathId' })],
    ['wrong layer field', orderedCursorMaterial({ layerKey: 'side' })],
    ['wrong patch field', orderedCursorMaterial({ patchKey: 'contentDigest' })],
    ['wrong line field', orderedCursorMaterial({ lineKey: 'offset' })],
    ['wrong version', orderedCursorMaterial({ version: 2 })],
    ['non-string observation digest', orderedCursorMaterial({ observationDigest: 1 })],
    ['malformed observation digest', orderedCursorMaterial({ observationDigest: 'a' })],
    ['non-string change id', orderedCursorMaterial({ changeId: 1 })],
    ['empty change id', orderedCursorMaterial({ changeId: '' })],
    ['unknown layer', orderedCursorMaterial({ layer: 'unknown' })],
    ['non-string patch digest', orderedCursorMaterial({ patchDigest: 1 })],
    ['malformed patch digest', orderedCursorMaterial({ patchDigest: 'b' })],
    ['non-number next line', orderedCursorMaterial({ nextLine: '1' })],
    ['non-integer next line', orderedCursorMaterial({ nextLine: 1.5 })],
    ['zero next line', orderedCursorMaterial({ nextLine: 0 })],
    ['maximum next line', orderedCursorMaterial({ nextLine: MAX_PROJECT_GIT_DIFF_TOTAL_LINES })],
  ])('rejects cursor material with %s', async (_case, material) => {
    const cursor = Buffer.from(JSON.stringify(material), 'utf8').toString('base64url') as ProjectGitDiffCursor
    await expect(readLocalProjectDiff(dependencies, binding, {
      expectedStatus: { version: 1, digest },
      changeId,
      layer: 'unstaged',
      cursor,
    }, signal)).resolves.toEqual({ ok: false, reason: 'invalid-cursor' })
  })

  it.each([
    ['observation', { observationDigest: 'c'.repeat(64) }],
    ['change', { changeId: `git-change-${'d'.repeat(64)}` }],
    ['layer', { layer: 'staged' }],
  ])('rejects a cursor bound to another %s before repository observation', async (_case, overrides) => {
    const cursor = Buffer.from(JSON.stringify(orderedCursorMaterial(overrides)), 'utf8')
      .toString('base64url') as ProjectGitDiffCursor
    await expect(readLocalProjectDiff(dependencies, binding, {
      expectedStatus: { version: 1, digest },
      changeId,
      layer: 'unstaged',
      cursor,
    }, signal)).resolves.toEqual({ ok: false, reason: 'cursor-stale' })
  })

  function orderedCursorMaterial(overrides: {
    readonly firstKey?: string
    readonly observationKey?: string
    readonly changeKey?: string
    readonly layerKey?: string
    readonly patchKey?: string
    readonly lineKey?: string
    readonly version?: unknown
    readonly observationDigest?: unknown
    readonly changeId?: unknown
    readonly layer?: unknown
    readonly patchDigest?: unknown
    readonly nextLine?: unknown
  } = {}): Record<string, unknown> {
    return {
      [overrides.firstKey ?? 'version']: overrides.version ?? 1,
      [overrides.observationKey ?? 'observationDigest']: overrides.observationDigest ?? digest,
      [overrides.changeKey ?? 'changeId']: overrides.changeId ?? changeId,
      [overrides.layerKey ?? 'layer']: overrides.layer ?? 'unstaged',
      [overrides.patchKey ?? 'patchDigest']: overrides.patchDigest ?? 'e'.repeat(64),
      [overrides.lineKey ?? 'nextLine']: overrides.nextLine ?? 1,
    }
  }
})

describe('project Diff output grammar', () => {
  const path = Buffer.from('literal path.txt')

  it.each([
    ['empty output', Buffer.alloc(0), 'missing'],
    ['text output', Buffer.from('1\t2\tliteral path.txt\0'), 'text'],
    ['zero-count text output', Buffer.from('0\t0\tliteral path.txt\0'), 'text'],
    ['binary output', Buffer.from('-\t-\tliteral path.txt\0'), 'binary'],
    ['missing terminator', Buffer.from('1\t2\tliteral path.txt'), 'malformed'],
    ['extra record', Buffer.from('1\t2\tliteral path.txt\0junk\0'), 'malformed'],
    ['empty added field', Buffer.from('\t2\tliteral path.txt\0'), 'malformed'],
    ['missing tabs', Buffer.from('12literal path.txt\0'), 'malformed'],
    ['empty deleted field', Buffer.from('1\t\tliteral path.txt\0'), 'malformed'],
    ['wrong path', Buffer.from('1\t2\tother.txt\0'), 'malformed'],
    ['binary added only', Buffer.from('-\t2\tliteral path.txt\0'), 'malformed'],
    ['binary deleted only', Buffer.from('1\t-\tliteral path.txt\0'), 'malformed'],
    ['leading-zero added count', Buffer.from('01\t2\tliteral path.txt\0'), 'malformed'],
    ['leading-zero deleted count', Buffer.from('1\t02\tliteral path.txt\0'), 'malformed'],
    ['non-decimal added count', Buffer.from('x\t2\tliteral path.txt\0'), 'malformed'],
    ['non-decimal deleted count', Buffer.from('1\tx\tliteral path.txt\0'), 'malformed'],
  ] as const)('classifies %s', (_case, bytes, expected) => {
    expect(parseProjectDiffBinaryPreflight(bytes, path)).toBe(expected)
  })

  it.each([
    ['empty output', Buffer.alloc(0), { ok: false, reason: 'malformed' }],
    ['missing final newline', Buffer.from('patch'), { ok: false, reason: 'malformed' }],
    ['embedded NUL', Buffer.from('patch\0\n'), { ok: false, reason: 'malformed' }],
    [
      'total byte overflow',
      Buffer.concat([Buffer.alloc(MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES, 0x78), Buffer.from('\n')]),
      { ok: false, reason: 'total-bytes' },
    ],
    ['invalid UTF-8', Buffer.from([0xff, 0x0a]), { ok: false, reason: 'invalid-utf8' }],
    [
      'total line overflow',
      Buffer.from('x\n'.repeat(MAX_PROJECT_GIT_DIFF_TOTAL_LINES + 1)),
      { ok: false, reason: 'total-lines' },
    ],
    [
      'line byte overflow',
      Buffer.from(`${'x'.repeat(MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES)}\n`),
      { ok: false, reason: 'line-bytes' },
    ],
    ['valid text', Buffer.from('first\nsecond\n'), { ok: true, lines: ['first', 'second'] }],
  ] as const)('parses %s', (_case, bytes, expected) => {
    expect(parseProjectDiffPatch(bytes)).toEqual(expected)
  })
})

describe('project Diff local failure projection', () => {
  it.each([
    ['matching identities', 'git', 'git', 'common', 'common', undefined],
    ['changed Git directory', 'changed', 'git', 'common', 'common', 'binding-stale'],
    ['changed common directory', 'git', 'git', 'changed', 'common', 'binding-stale'],
  ] as const)(
    'projects %s',
    (_case, gitDirectory, expectedGitDirectory, commonDirectory, expectedCommonDirectory, expected) => {
      expect(projectDiffAdministrativeIdentityFailure(
        gitDirectory,
        expectedGitDirectory,
        commonDirectory,
        expectedCommonDirectory,
      )).toBe(expected)
    },
  )

  it.each([
    ['malformed', 'malformed'],
    ['ambiguous', 'ambiguous'],
    ['unavailable', 'unavailable'],
    ['limit', 'unavailable'],
    ['unsupported-index-state', 'unavailable'],
    ['missing', 'binding-stale'],
    ['not-directory', 'binding-stale'],
    ['not-git', 'binding-stale'],
    ['bare', 'binding-stale'],
    ['prunable', 'binding-stale'],
  ] as const)('projects selection failure %s', (reason, expected) => {
    expect(projectDiffSelectionFailureReason(reason)).toBe(expected)
  })

  it.each([
    ['malformed', 'malformed'],
    ['ambiguous', 'ambiguous'],
    ['unavailable', 'unavailable'],
    ['not-git', 'binding-stale'],
    ['bare', 'binding-stale'],
    ['prunable', 'binding-stale'],
  ] as const)('projects repository-open failure %s', (reason, expected) => {
    expect(projectDiffRepositoryOpenFailureReason(reason)).toBe(expected)
  })
})

describe('project Diff lifecycle boundaries', () => {
  const digest = 'a'.repeat(64)
  const changeId = `git-change-${'b'.repeat(64)}` as ProjectGitChangeId
  const binding = fakeBinding()
  const signal = new AbortController().signal

  it('rejects duplicate change and inventory identities without reading a patch', async () => {
    const change = fakeOrdinaryChange(changeId, 'tracked.txt')
    const duplicateChanges = fakeObservation({ changes: [change, change] })
    expect(resolveProjectDiffTarget(duplicateChanges, diffRequest(changeId)))
      .toEqual({ ok: false, reason: 'change-ambiguous' })

    const missingInventory = fakeObservation({ changes: [change], entries: [] })
    expect(resolveProjectDiffTarget(missingInventory, diffRequest(changeId)))
      .toEqual({ ok: false, reason: 'change-missing' })

    const duplicateInventory = fakeObservation({ changes: [change], entries: [fakeEntry(), fakeEntry()] })
    expect(resolveProjectDiffTarget(duplicateInventory, diffRequest(changeId)))
      .toEqual({ ok: false, reason: 'change-ambiguous' })
  })

  it('rejects either a requested conflict layer or an observed unmerged row', () => {
    expect(resolveProjectDiffTarget(fakeObservation(), {
      ...diffRequest(changeId),
      layer: 'conflict',
    })).toEqual({ ok: false, reason: 'conflict' })
    expect(resolveProjectDiffTarget(fakeObservation({
      changes: [fakeUnmergedChange(changeId)],
    }), diffRequest(changeId))).toEqual({ ok: false, reason: 'conflict' })
  })

  it('rejects an inventory path beyond the portable command bound', async () => {
    const path = 'x'.repeat(64 * 1024 + 1)
    const observed = fakeObservation({
      changes: [fakeOrdinaryChange(changeId, path)],
      entries: [fakeEntry(path)],
    })
    expect(resolveProjectDiffTarget(observed, diffRequest(changeId)))
      .toEqual({ ok: false, reason: 'command-length' })
  })

  it('binds the cursor to complete patch bytes and a valid next line', async () => {
    const request = { expectedStatus: { version: 1 as const, digest }, changeId, layer: 'unstaged' as const }
    const first = completeProjectDiffPage(request, undefined, Buffer.from('line\n'))
    if (!first.ok) throw new Error(`fixture Diff failed: ${first.reason}`)

    const staleCursor = encodeTestCursor({
      observationDigest: digest,
      changeId,
      layer: 'unstaged',
      patchDigest: 'f'.repeat(64),
      nextLine: 1,
    })
    expect(completeProjectDiffPage(request, decodeTestCursor(staleCursor), Buffer.from('line\n')))
      .toEqual({ ok: false, reason: 'cursor-stale' })

    const exhaustedCursor = encodeTestCursor({
      observationDigest: digest,
      changeId,
      layer: 'unstaged',
      patchDigest: first.page.patchFingerprint.digest,
      nextLine: 1,
    })
    expect(completeProjectDiffPage(request, decodeTestCursor(exhaustedCursor), Buffer.from('line\n')))
      .toEqual({ ok: false, reason: 'invalid-cursor' })
  })

  it('maps selection and status-projection boundary failures without swallowing unknown errors', async () => {
    const mismatch = fakeDependencies({
      inspectSelection: async () => { throw new BoundProjectResourceMismatchError() },
    })
    await expect(observeBoundProject(mismatch, binding, signal))
      .resolves.toEqual({ ok: false, reason: 'binding-stale' })

    const selectionFailure = fakeDependencies({
      inspectSelection: async () => ({ ok: false, reason: 'limit' }),
    })
    await expect(observeBoundProject(selectionFailure, binding, signal))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })

    for (const [reason, expected] of [
      ['invalid-path', 'malformed'],
      ['unavailable', 'unavailable'],
    ] as const) {
      const projectionFailure = fakeDependencies({
        inspectSelection: async () => fakeStableSelection(),
        buildStatus: () => { throw new ProjectGitStatusProjectionError(reason) },
      })
      await expect(observeBoundProject(projectionFailure, binding, signal))
        .resolves.toEqual({ ok: false, reason: expected })
    }

    const unknown = new Error('unknown selection failure')
    const unknownSelection = fakeDependencies({ inspectSelection: async () => { throw unknown } })
    await expect(observeBoundProject(unknownSelection, binding, signal)).rejects.toBe(unknown)

    const unknownProjection = fakeDependencies({
      inspectSelection: async () => fakeStableSelection(),
      buildStatus: () => { throw unknown },
    })
    await expect(observeBoundProject(unknownProjection, binding, signal)).rejects.toBe(unknown)
  })

  it('returns a failed final observation after a stable patch capture', async () => {
    let selections = 0
    const dependencies = patchDependencies(fakeRepository([
      rawOutput(Buffer.from('1\t1\ttracked.txt\0')),
      rawOutput(Buffer.from('patch\n')),
      rawOutput(Buffer.from('1\t1\ttracked.txt\0')),
      rawOutput(Buffer.from('patch\n')),
    ]), {
      inspectSelection: async () => ++selections === 4
        ? { ok: false, reason: 'not-git' }
        : fakeStableSelection(),
    })
    await expect(readLocalProjectDiff(dependencies, binding, diffRequest(changeId), signal))
      .resolves.toEqual({ ok: false, reason: 'binding-stale' })
  })
})

describe('stable project Diff patch boundaries', () => {
  const signal = new AbortController().signal
  const path = Buffer.from('tracked.txt')
  const textPreflight = Buffer.from('1\t1\ttracked.txt\0')
  const patch = Buffer.from('patch\n')

  it.each([
    ['malformed preflight', [{ stdout: Buffer.from('malformed'), stderr: Buffer.alloc(0) }], 'malformed'],
    [
      'missing layer',
      [rawOutput(Buffer.alloc(0)), rawOutput(Buffer.alloc(0))],
      'layer-missing',
    ],
    [
      'changed preflight',
      [rawOutput(textPreflight), rawOutput(patch), rawOutput(Buffer.from('2\t1\ttracked.txt\0'))],
      'ambiguous',
    ],
    [
      'empty stable patch',
      [rawOutput(textPreflight), rawOutput(Buffer.alloc(0)), rawOutput(textPreflight), rawOutput(Buffer.alloc(0))],
      'layer-missing',
    ],
    ['stderr output', [{ stdout: textPreflight, stderr: Buffer.from('diagnostic') }], 'unavailable'],
    ['nonzero Git', [new GitCommandError('nonzero', 1)], 'unavailable'],
    ['unknown runner failure', [new Error('unknown runner failure')], 'unavailable'],
  ] as const)('maps %s', async (_case, steps, expected) => {
    await expect(readPatchWith(fakeRepository([...steps]), path, signal))
      .resolves.toEqual({ ok: false, reason: expected })
  })

  it('maps source-control changes and all aggregate budget rejection forms', async () => {
    const changed = fakeRepository([rawOutput(textPreflight)], {
      assertSourceControlUnchanged: async () => { throw new RepositoryControlChangedError() },
    })
    await expect(readPatchWith(changed, path, signal))
      .resolves.toEqual({ ok: false, reason: 'ambiguous' })

    const budget = fakeRepository([(_args, outputBudget) => {
      expect(outputBudget?.observe(Number.NaN)).toBe(false)
      expect(outputBudget?.observe(-1)).toBe(false)
      expect(outputBudget?.observe(MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES + 1)).toBe(false)
      throw new GitCommandError('stdout-limit')
    }])
    await expect(readPatchWith(budget, path, signal))
      .resolves.toEqual({ ok: false, reason: 'total-bytes' })
  })

  it('returns failures from the first and second observation checkpoints', async () => {
    const firstFailure = patchDependencies(fakeRepository([rawOutput(textPreflight)]), {
      inspectSelection: async () => ({ ok: false, reason: 'not-git' }),
    })
    await expect(readStablePatch(
      firstFailure,
      fakeBinding(),
      fakeObservation(),
      path,
      'unstaged',
      signal,
    )).resolves.toEqual({ ok: false, reason: 'binding-stale' })

    let selections = 0
    const secondFailure = patchDependencies(fakeRepository([rawOutput(textPreflight), rawOutput(patch)]), {
      inspectSelection: async () => ++selections === 1
        ? fakeStableSelection()
        : { ok: false, reason: 'not-git' },
    })
    await expect(readStablePatch(
      secondFailure,
      fakeBinding(),
      fakeObservation(),
      path,
      'unstaged',
      signal,
    )).resolves.toEqual({ ok: false, reason: 'binding-stale' })
  })

  it('maps invalid paths and repository-open failures before running Git', async () => {
    await expect(readPatchWith(fakeRepository([]), Buffer.from([0xff]), signal))
      .resolves.toEqual({ ok: false, reason: 'malformed' })

    const unavailable = fakeDependencies({ openRepository: async () => ({ kind: 'malformed' }) })
    await expect(readStablePatch(
      unavailable,
      fakeBinding(),
      fakeObservation(),
      path,
      'unstaged',
      signal,
    )).resolves.toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects repository, Workspace, and administrative identity drift at admission', async () => {
    const cases: readonly [string, SafeRepositoryView, LocalProjectDiffDependencies, ActiveHostProjectBinding][] = [
      [
        'repository path',
        fakeRepository([], { topLevelPath: 'C:\\other' }),
        fakeDependencies({}),
        fakeBinding(),
      ],
      [
        'lock state',
        fakeRepository([], { locked: true }),
        fakeDependencies({}),
        fakeBinding(),
      ],
      [
        'Git directory path',
        fakeRepository([], { gitDirectoryPath: 'C:\\repo\\other-git' }),
        fakeDependencies({}),
        fakeBinding(),
      ],
      [
        'common directory path',
        fakeRepository([], { commonDirectoryPath: 'C:\\repo\\other-common' }),
        fakeDependencies({}),
        fakeBinding(),
      ],
      [
        'Workspace membership',
        fakeRepository([]),
        fakeDependencies({}, { workspaces: [] }),
        fakeBinding(),
      ],
      [
        'Workspace identity',
        fakeRepository([]),
        fakeDependencies({}, {
          workspaces: [{ id: WorkspaceId('workspace-other'), path: 'C:\\repo' }],
        }),
        fakeBinding(),
      ],
      [
        'Git directory identity',
        fakeRepository([]),
        fakeDependencies({}, { identityDigests: { 'C:\\repo\\.git': 'changed' } }),
        fakeBinding(),
      ],
      [
        'separate common directory identity',
        fakeRepository([], { commonDirectoryPath: 'C:\\repo\\common' }),
        fakeDependencies({}, { identityDigests: { 'C:\\repo\\common': 'changed' } }),
        fakeBinding({ commonDirectoryPath: 'C:\\repo\\common' }),
      ],
    ]
    for (const [label, repository, base, binding] of cases) {
      const dependencies = patchDependencies(repository, base.internals ?? {}, base)
      await expect(readStablePatch(dependencies, binding, fakeObservation({
        commonDirectoryPath: repository.commonDirectoryPath,
      }), path, 'unstaged', signal), label).resolves.toEqual({ ok: false, reason: 'binding-stale' })
    }
  })
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => {
    await context.fiber.dispose()
  }))
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true })
  }))
})

describe('LocalSakiHostExecution project Diff', () => {
  it('returns one stable staged file patch through the bound Host interface', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)

    await writeFile(join(root, 'tracked.txt'), 'staged\n')
    await git(root, 'add', '--', 'tracked.txt')
    const status = await execution.inspectProject({ binding }, signal)
    expect(status.ok, JSON.stringify(status)).toBe(true)
    if (!status.ok) return
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    expect(change).toBeDefined()
    if (change === undefined) return

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'staged',
    }, signal)

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.page).toMatchObject({
      pageVersion: 1,
      observation: status.observation.fingerprint,
      changeId: change.id,
      layer: 'staged',
      range: {
        startLine: 0,
        endLineExclusive: 7,
        totalLines: 7,
      },
      lines: [
        'diff --git a/tracked.txt b/tracked.txt',
        expect.stringMatching(/^index [0-9a-f]+\.\.[0-9a-f]+ 100644$/u),
        '--- a/tracked.txt',
        '+++ b/tracked.txt',
        '@@ -1 +1 @@',
        '-initial',
        '+staged',
      ],
      omittedBeforeLines: 0,
      omittedAfterLines: 0,
      truncated: false,
    })
    expect(result.page.patchFingerprint.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.page.pageUtf8Bytes).toBe(result.page.totalUtf8Bytes)
    expect(result.page.nextCursor).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(root)
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('reads a staged patch against the deterministic empty tree for an unborn HEAD', async () => {
    const root = await unbornRepository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'first.txt'), 'first\n')
    await git(root, 'add', '--', 'first.txt')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    expect(status.observation.head.kind).toBe('unborn')
    const change = status.observation.changes.find(value => value.path === 'first.txt')
    if (change === undefined) throw new Error('unborn staged change is absent')

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'staged',
    }, signal)

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.page.lines).toContain('new file mode 100644')
    expect(result.page.lines).toContain('+first')
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('resolves an unstaged change id to one literal path and fixed Git argv', async () => {
    const root = await repository()
    const path = '-literal[1] file.txt'
    await writeFile(join(root, path), 'initial\n')
    await git(root, 'add', '--', path)
    await git(root, 'commit', '-m', 'add literal path')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, path), 'unstaged\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === path)
    if (change === undefined) throw new Error('literal path change is absent')
    const commands = observeDiffCommands(execution)

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.page.lines).toContain('-initial')
    expect(result.page.lines).toContain('+unstaged')
    const semantic = [
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--ignore-submodules=all',
      '--submodule=short',
      '--ita-invisible-in-index',
      '--',
      path,
    ]
    expect(commands).toEqual([
      ['--literal-pathspecs', '-c', 'core.quotePath=true', 'diff', '--numstat', '-z', ...semantic],
      [
        '--literal-pathspecs', '-c', 'core.quotePath=true', 'diff',
        '--patch', '--no-color', '--default-prefix', '--full-index', '--diff-algorithm=default',
        '--no-indent-heuristic', '--unified=3', '--inter-hunk-context=0',
        ...semantic,
      ],
      ['--literal-pathspecs', '-c', 'core.quotePath=true', 'diff', '--numstat', '-z', ...semantic],
      [
        '--literal-pathspecs', '-c', 'core.quotePath=true', 'diff',
        '--patch', '--no-color', '--default-prefix', '--full-index', '--diff-algorithm=default',
        '--no-indent-heuristic', '--unified=3', '--inter-hunk-context=0',
        ...semantic,
      ],
    ])
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('retains index-flag status evidence while reading an unrelated ordinary Diff', async () => {
    const root = await repository()
    await writeFile(join(root, 'skipped.txt'), 'skipped\n')
    await git(root, 'add', '--', 'skipped.txt')
    await git(root, 'commit', '-m', 'add skipped path')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await git(root, 'update-index', '--skip-worktree', '--', 'skipped.txt')
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    expect(status.observation.structuredMutation).toEqual({
      available: false,
      blockers: ['index-flags'],
    })
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('ordinary change is absent')

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.page.lines).toContain('-initial')
    expect(result.page.lines).toContain('+changed')
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('returns a typed unavailable result for untracked content without invoking Diff', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'untracked.txt'), 'untracked\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'untracked.txt')
    if (change === undefined) throw new Error('untracked change is absent')
    const commands = observeDiffCommands(execution)

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'untracked' })
    expect(commands).toEqual([])
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects staged and unstaged Gitlink layers before invoking Diff', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    const commit = await gitText(root, 'rev-parse', 'HEAD')
    await git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},module`)
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'module')
    if (change === undefined) throw new Error('Gitlink change is absent')
    expect(change.submodule.kind).toBe('submodule')
    const commands = observeDiffCommands(execution)

    for (const layer of ['staged', 'unstaged'] as const) {
      const result = await execution.readDiff(binding, {
        expectedStatus: status.observation.fingerprint,
        changeId: change.id,
        layer,
      }, signal)

      expect(result, layer).toEqual({ ok: false, reason: 'unavailable' })
    }
    expect(commands).toEqual([])
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('returns a typed unavailable result for a conflicted change without guessing a patch', async () => {
    const root = await conflictedRepository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await expectGitFailure(root, 'merge', 'other')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('conflicted change is absent')
    const commands = observeDiffCommands(execution)

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'conflict',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'conflict' })
    expect(commands).toEqual([])
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('classifies a binary patch without returning repository bytes', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), Buffer.from([0, 1, 2, 3]))
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('binary change is absent')
    const commands = observeDiffCommands(execution)

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'binary' })
    expect(commands).toHaveLength(2)
    expect(commands.every(command => command.includes('--numstat') && !command.includes('--patch'))).toBe(true)
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects a transient binary classification between matching outer observations', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'outer\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change is absent')
    let commands = 0
    interceptDiffCommands(execution, async (actual, args) => {
      commands += 1
      if (commands === 1) await writeFile(join(root, 'tracked.txt'), Buffer.from([0, 1, 2, 3]))
      const output = await actual.run(...args)
      if (commands === 2) await writeFile(join(root, 'tracked.txt'), 'outer\n')
      return output
    })

    try {
      const result = await execution.readDiff(binding, {
        expectedStatus: status.observation.fingerprint,
        changeId: change.id,
        layer: 'unstaged',
      }, signal)

      expect(result).toEqual({ ok: false, reason: 'observation-stale' })
    } finally {
      await writeFile(join(root, 'tracked.txt'), 'outer\n')
    }
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects a transient missing layer between matching outer observations', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'outer\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change is absent')
    let commands = 0
    interceptDiffCommands(execution, async (actual, args) => {
      commands += 1
      if (commands === 1) await writeFile(join(root, 'tracked.txt'), 'initial\n')
      const output = await actual.run(...args)
      if (commands === 2) await writeFile(join(root, 'tracked.txt'), 'outer\n')
      return output
    })

    try {
      const result = await execution.readDiff(binding, {
        expectedStatus: status.observation.fingerprint,
        changeId: change.id,
        layer: 'unstaged',
      }, signal)

      expect(result).toEqual({ ok: false, reason: 'observation-stale' })
    } finally {
      await writeFile(join(root, 'tracked.txt'), 'outer\n')
    }
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('replays one stable patch into line- and UTF-8-byte-bounded cursor pages', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    const content = Array.from(
      { length: 1_200 },
      (_, index) => `${String(index).padStart(4, '0')}:${'界'.repeat(100)}`,
    ).join('\n') + '\n'
    await writeFile(join(root, 'tracked.txt'), content)
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('large change is absent')

    const first = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(first.ok, JSON.stringify(first)).toBe(true)
    if (!first.ok) return
    expect(first.page.lines.length).toBeLessThanOrEqual(MAX_PROJECT_GIT_DIFF_PAGE_LINES)
    expect(first.page.pageUtf8Bytes).toBeLessThanOrEqual(MAX_PROJECT_GIT_DIFF_PAGE_UTF8_BYTES)
    expect(first.page.range.startLine).toBe(0)
    expect(first.page.range.endLineExclusive).toBe(first.page.lines.length)
    expect(first.page.omittedAfterLines).toBeGreaterThan(0)
    expect(first.page.nextCursor).toBeDefined()
    if (first.page.nextCursor === undefined) return

    const wrongLayer = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'staged',
      cursor: first.page.nextCursor,
    }, signal)
    expect(wrongLayer).toEqual({ ok: false, reason: 'cursor-stale' })

    const second = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
      cursor: first.page.nextCursor,
    }, signal)

    expect(second.ok, JSON.stringify(second)).toBe(true)
    if (!second.ok) return
    expect(second.page.patchFingerprint).toEqual(first.page.patchFingerprint)
    expect(second.page.totalUtf8Bytes).toBe(first.page.totalUtf8Bytes)
    expect(second.page.range.startLine).toBe(first.page.range.endLineExclusive)
    expect(second.page.range.totalLines).toBe(first.page.range.totalLines)
    expect(second.page.range.endLineExclusive).toBe(second.page.range.totalLines)
    expect(second.page.nextCursor).toBeUndefined()
    expect([...first.page.lines, ...second.page.lines]).toHaveLength(first.page.range.totalLines)

    await writeFile(join(root, 'tracked.txt'), `${content}changed\n`)
    const stale = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
      cursor: first.page.nextCursor,
    }, signal)
    expect(stale).toEqual({ ok: false, reason: 'observation-stale' })
  }, 60_000)

  it('rejects a malformed opaque cursor before observing the repository', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    const commands = observeAllCommands(execution)

    const result = await execution.readDiff(binding, {
      expectedStatus: { version: 1, digest: 'a'.repeat(64) },
      changeId: `git-change-${'b'.repeat(64)}` as ProjectGitChangeId,
      layer: 'unstaged',
      cursor: 'not-base64url!' as ProjectGitDiffCursor,
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'invalid-cursor' })
    expect(commands).toEqual([])
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('fences a changed status observation before invoking Diff', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'first\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change is absent')
    await writeFile(join(root, 'tracked.txt'), 'second\n')
    const commands = observeDiffCommands(execution)

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'observation-stale' })
    expect(commands).toEqual([])
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects a change id absent from the exact status observation', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const commands = observeDiffCommands(execution)

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: `git-change-${'b'.repeat(64)}` as ProjectGitChangeId,
      layer: 'unstaged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'change-missing' })
    expect(commands).toEqual([])
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects a layer not present on the selected change', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'unstaged\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change is absent')
    const commands = observeDiffCommands(execution)

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'staged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'layer-missing' })
    expect(commands).toEqual([])
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('does not execute a selected worktree clean filter while reading Diff', async () => {
    const root = await repository()
    const marker = join(root, 'filter-ran')
    const script = join(root, 'filter-sentinel.cjs')
    const ownerNonce = randomUUID()
    await writeFile(
      script,
      'if (process.env.SAKI_DIFF_FILTER_TEST_OWNER === process.argv[3]) '
      + 'require("node:fs").writeFileSync(process.argv[2], "ran"); process.stdin.pipe(process.stdout)\n',
    )
    await writeFile(join(root, '.gitattributes'), 'tracked.txt filter=sentinel\n')
    await git(root, 'add', '--', '.gitattributes', 'filter-sentinel.cjs')
    await git(root, 'commit', '-m', 'add filter declaration')
    const filterCommand = [process.execPath, script, marker, ownerNonce]
      .map(value => `'${value.replaceAll("'", "'\"'\"'")}'`)
      .join(' ')
    await git(root, 'config', 'filter.sentinel.clean', filterCommand)
    await git(root, 'config', 'filter.sentinel.required', 'true')
    const previousOwner = process.env.SAKI_DIFF_FILTER_TEST_OWNER
    process.env.SAKI_DIFF_FILTER_TEST_OWNER = ownerNonce
    try {
      const execution = await provider(root)
      const signal = new AbortController().signal
      const binding = await register(execution, root, signal)
      await writeFile(join(root, 'tracked.txt'), 'changed\n')
      const status = await execution.inspectProject({ binding }, signal)
      if (!status.ok) throw new Error(`status failed: ${status.reason}`)
      const change = status.observation.changes.find(value => value.path === 'tracked.txt')
      if (change === undefined) throw new Error('filtered change is absent')
      const commands = observeDiffCommands(execution)

      const result = await execution.readDiff(binding, {
        expectedStatus: status.observation.fingerprint,
        changeId: change.id,
        layer: 'unstaged',
      }, signal)

      expect(result).toEqual({ ok: false, reason: 'unavailable' })
      expect(commands).toEqual([])
      await expect(access(marker)).rejects.toBeDefined()
    } finally {
      if (previousOwner === undefined) delete process.env.SAKI_DIFF_FILTER_TEST_OWNER
      else process.env.SAKI_DIFF_FILTER_TEST_OWNER = previousOwner
    }
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects text patch bytes that are not valid UTF-8', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), Buffer.from([0xff, 0xfe, 0x0a]))
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('invalid UTF-8 change is absent')

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'invalid-utf8' })
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects a patch that exceeds the configured complete-output byte bound', async () => {
    const root = await repository()
    const execution = await provider(root, { ...CONFIG, maxGitStdoutBytes: 4 * 1024 })
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), `${'x'.repeat(8 * 1024)}\n`)
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('large-byte change is absent')

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'total-bytes' })
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects a complete patch containing an oversized UTF-8 line', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), `${'x'.repeat(70 * 1024)}\n`)
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('large-line change is absent')

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'line-bytes' })
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects a complete patch containing too many logical lines', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'x\n'.repeat(MAX_PROJECT_GIT_DIFF_TOTAL_LINES))
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('many-line change is absent')

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'total-lines' })
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects provider-resolved paths outside portable command-line bounds', () => {
    expect(projectDiffCommandFits(Buffer.from('tracked.txt'), '/worktree', 'linux')).toBe(true)
    expect(projectDiffCommandFits(Buffer.from('tracked.txt'), 'C:\\worktree', 'win32')).toBe(true)
    expect(projectDiffCommandFits(Buffer.from([0xff]), 'C:\\worktree', 'win32')).toBe(false)
    expect(projectDiffCommandFits(Buffer.alloc(64 * 1024 + 1), 'C:\\worktree', 'linux')).toBe(false)
    expect(projectDiffCommandFits(Buffer.from('tracked.txt'), `C:\\${'x'.repeat(15_000)}`, 'win32')).toBe(false)
  })

  it('propagates caller cancellation before observing Diff state', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change is absent')
    const commands = observeAllCommands(execution)
    const cancellation = new Error('caller canceled Diff')
    const controller = new AbortController()
    controller.abort(cancellation)

    await expect(execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, controller.signal)).rejects.toBe(cancellation)
    expect(commands).toEqual([])
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('propagates caller cancellation from an active Diff command', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change is absent')
    const cancellation = new Error('caller canceled active Diff')
    const controller = new AbortController()
    interceptDiffCommands(execution, async (actual, args) => {
      controller.abort(cancellation)
      return await actual.run(...args)
    })

    await expect(execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, controller.signal)).rejects.toBe(cancellation)
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('maps a bounded Diff command timeout without exposing child diagnostics', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change is absent')
    interceptDiffCommands(execution, async () => {
      throw new GitCommandError('timeout')
    })

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'time' })
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects unequal patch bytes produced for one stable status', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'first\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change is absent')
    let patchPasses = 0
    interceptDiffCommands(execution, async (actual, args) => {
      const output = await actual.run(...args)
      if (!args[1].includes('--patch')) return output
      patchPasses += 1
      return patchPasses === 1
        ? {
          ...output,
          stdout: Buffer.from(output.stdout.toString('utf8').replace('+first\n', '+transient\n'), 'utf8'),
        }
        : output
    })

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'ambiguous' })
    expect(patchPasses).toBe(2)
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('rejects equal patch passes captured from a transient status between matching outer observations', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'outer\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change is absent')
    let commands = 0
    interceptDiffCommands(execution, async (actual, args) => {
      commands += 1
      if (commands === 1) await writeFile(join(root, 'tracked.txt'), 'transient\n')
      const output = await actual.run(...args)
      if (commands === 4) await writeFile(join(root, 'tracked.txt'), 'outer\n')
      return output
    })

    try {
      const result = await execution.readDiff(binding, {
        expectedStatus: status.observation.fingerprint,
        changeId: change.id,
        layer: 'unstaged',
      }, signal)

      expect(result).toEqual({ ok: false, reason: 'observation-stale' })
    } finally {
      await writeFile(join(root, 'tracked.txt'), 'outer\n')
    }
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)

  it('revalidates the bound repository identity before invoking Diff', async () => {
    const root = await repository()
    const replacement = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await register(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const status = await execution.inspectProject({ binding }, signal)
    if (!status.ok) throw new Error(`status failed: ${status.reason}`)
    const change = status.observation.changes.find(value => value.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change is absent')
    const displacedGit = `${root}-original-git`
    roots.push(displacedGit)
    await rename(join(root, '.git'), displacedGit)
    await rename(join(replacement, '.git'), join(root, '.git'))
    const commands = observeDiffCommands(execution)

    const result = await execution.readDiff(binding, {
      expectedStatus: status.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'binding-stale' })
    expect(commands).toEqual([])
  }, REAL_GIT_DIFF_TEST_TIMEOUT_MS)
})

function fakeBinding(options: { readonly commonDirectoryPath?: string } = {}): ActiveHostProjectBinding {
  const expectedInspection = fakeInspection(options.commonDirectoryPath)
  return {
    id: BINDING_ID,
    revision: 0,
    health: 'active',
    hostId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    expectedInspection,
    inheritedChangeBaseline: expectedInspection.projection.baseline,
  }
}

function fakeOrdinaryChange(
  id: ProjectGitChangeId = `git-change-${'b'.repeat(64)}` as ProjectGitChangeId,
  path = 'tracked.txt',
): Extract<ProjectGitChange, { readonly kind: 'ordinary' }> {
  const material: Omit<Extract<ProjectGitChange, { readonly kind: 'ordinary' }>, 'id' | 'fingerprint'> = {
    path,
    attribution: 'not-inherited',
    kind: 'ordinary',
    indexStatus: 'unchanged',
    worktreeStatus: 'modified',
    submodule: { kind: 'not-submodule' },
    head: { mode: '100644', objectId: '1'.repeat(40) },
    index: { mode: '100644', objectId: '1'.repeat(40) },
    worktreeMode: '100644',
    worktreeEvidence: {
      kind: 'regular',
      mode: '100644',
      byteLength: 7,
      contentDigest: '3'.repeat(64),
    },
  }
  return {
    id,
    fingerprint: computeProjectGitChangeFingerprint(material),
    ...material,
  }
}

function fakeUnmergedChange(
  id: ProjectGitChangeId,
  path = 'tracked.txt',
): Extract<ProjectGitChange, { readonly kind: 'unmerged' }> {
  const material: Omit<Extract<ProjectGitChange, { readonly kind: 'unmerged' }>, 'id' | 'fingerprint'> = {
    path,
    attribution: 'not-inherited',
    kind: 'unmerged',
    indexStatus: 'unmerged',
    worktreeStatus: 'present',
    conflict: 'both-modified',
    submodule: { kind: 'not-submodule' },
    stages: {
      base: { mode: '100644', objectId: '1'.repeat(40) },
      ours: { mode: '100644', objectId: '2'.repeat(40) },
      theirs: { mode: '100644', objectId: '3'.repeat(40) },
    },
    worktreeMode: '100644',
    worktreeEvidence: {
      kind: 'regular',
      mode: '100644',
      byteLength: 7,
      contentDigest: '4'.repeat(64),
    },
  }
  return { id, fingerprint: computeProjectGitChangeFingerprint(material), ...material }
}

function fakeEntry(path = 'tracked.txt'): CapturedRepositoryInventoryEntry {
  return {
    path: Buffer.from(path),
    head: { mode: '100644', objectId: '1'.repeat(40) },
    index: { mode: '100644', objectId: '1'.repeat(40) },
    stages: [undefined, undefined, undefined],
    untracked: false,
    current: {
      kind: 'captured',
      evidence: { kind: 'regular', mode: '100644', byteLength: 7, contentDigest: '3'.repeat(64) },
      rawObjectId: '2'.repeat(40),
      rawByteLength: 7,
      gitEvidenceBytes: 0,
    },
    conversion: { executableFilter: false, unmodeled: false, lineEnding: false },
  }
}

const FAKE_BASELINE: InheritedChangeBaseline = {
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
  digest: '5'.repeat(64),
}

function fakeInspection(commonDirectoryPath = 'C:\\repo\\.git'): ProjectSelectionInspection {
  return {
    projection: {
      observationVersion: 2,
      hostId: HOST_ID,
      displayLocation: 'repository',
      objectFormat: 'sha1',
      head: { kind: 'commit', objectId: '1'.repeat(40), symbolicRef: 'refs/heads/main' },
      locked: false,
      inheritedChangeEntryCount: 0,
      conversionAmbiguous: false,
      remotes: [],
      automaticMutationEligible: true,
      blockingReasons: [],
      fingerprint: { version: 2, digest: '6'.repeat(64) },
      baseline: FAKE_BASELINE,
    },
    trusted: {
      canonicalWorktreePath: 'C:\\repo',
      canonicalGitDirectory: 'C:\\repo\\.git',
      canonicalCommonGitDirectory: commonDirectoryPath,
      gitDirectoryIdentity: { version: 1, digest: 'git-identity' },
      commonGitDirectoryIdentity: { version: 1, digest: 'git-identity' },
      comparison: { fileMode: true, symlinks: true, autocrlf: false },
    },
  }
}

function fakeObservation(options: {
  readonly changes?: readonly ProjectGitChange[]
  readonly entries?: readonly ReturnType<typeof fakeEntry>[]
  readonly commonDirectoryPath?: string
} = {}): BoundProjectObservation {
  const digest = 'a'.repeat(64)
  const inspection = fakeInspection(options.commonDirectoryPath)
  const inventory: CapturedRepositoryInventory = {
    objectFormat: 'sha1',
    comparison: inspection.trusted.comparison,
    allowlistedGitEvidenceBytes: 0,
    capture: { elapsedMs: 1, rawBytes: 7 },
    entries: options.entries ?? [fakeEntry()],
  }
  const status: ProjectGitStatusObservation = {
    observationVersion: 1,
    observedAt: 1,
    bindingId: BINDING_ID,
    bindingRevision: 0,
    bindingHealth: 'active',
    locked: false,
    objectFormat: 'sha1',
    head: { kind: 'commit', objectId: '1'.repeat(40), symbolicRef: 'refs/heads/main' },
    branch: { kind: 'attached', ref: 'refs/heads/main', name: 'main' },
    index: { kind: 'tree', treeId: '2'.repeat(40) },
    worktree: { version: 1, digest: '7'.repeat(64) },
    changes: options.changes ?? [fakeOrdinaryChange()],
    structuredMutation: { available: true, blockers: [] },
    fingerprint: { version: 1, digest },
  }
  return {
    inspection,
    inventory,
    status,
  }
}

function fakeStableSelection(observed = fakeObservation()) {
  return {
    ok: true as const,
    inspection: observed.inspection,
    inventory: observed.inventory,
    status: fakeVerifiedStatus(),
    unsupportedIndexState: false,
  }
}

function fakeVerifiedStatus(): VerifiedRepositoryStatus {
  return {
    branch: {
      oid: { kind: 'commit', objectId: '1'.repeat(40) },
      head: { kind: 'attached', name: 'main' },
    },
    objectIdWidth: 40,
    entries: [{
      kind: 'ordinary',
      path: Buffer.from('tracked.txt'),
      indexStatus: 'unchanged',
      worktreeStatus: 'modified',
      submodule: { kind: 'not-submodule' },
      head: { mode: '100644', objectId: '1'.repeat(40) },
      index: { mode: '100644', objectId: '1'.repeat(40) },
      worktreeMode: '100644',
    }],
    index: { kind: 'tree', treeId: '2'.repeat(40) },
  }
}

function fakeDependencies(
  internals: LocalProjectDiffInternals,
  options: {
    readonly workspaces?: readonly { readonly id: typeof WORKSPACE_ID; readonly path: string }[]
    readonly identityDigests?: Readonly<Record<string, string>>
  } = {},
): LocalProjectDiffDependencies {
  return {
    fs: {},
    workspaces: {
      list: () => options.workspaces ?? [{ id: WORKSPACE_ID, path: 'C:\\repo' }],
    },
    git: {},
    config: CONFIG,
    identityReader: async (path: string) => ({ digest: options.identityDigests?.[path] ?? 'git-identity' }),
    internals,
  } as unknown as LocalProjectDiffDependencies
}

interface FakeDiffOutput {
  readonly stdout: Buffer
  readonly stderr: Buffer
}

type FakeDiffStep = FakeDiffOutput | Error | ((args: readonly string[], budget: RawOutputBudget | undefined) => FakeDiffOutput)

function rawOutput(stdout: Buffer): FakeDiffOutput {
  return { stdout, stderr: Buffer.alloc(0) }
}

function fakeRepository(
  steps: readonly FakeDiffStep[],
  overrides: {
    readonly topLevelPath?: string
    readonly gitDirectoryPath?: string
    readonly commonDirectoryPath?: string
    readonly locked?: boolean
    readonly assertSourceControlUnchanged?: SafeRepositoryView['assertSourceControlUnchanged']
  } = {},
): SafeRepositoryView {
  const remaining = [...steps]
  return {
    topLevelPath: overrides.topLevelPath ?? 'C:\\repo',
    gitDirectoryPath: overrides.gitDirectoryPath ?? 'C:\\repo\\.git',
    commonDirectoryPath: overrides.commonDirectoryPath ?? 'C:\\repo\\.git',
    privateGitDirectory: {
      path: 'C:\\private-git',
      async assertIntegrity() {},
      async [Symbol.asyncDispose]() {},
    },
    locked: overrides.locked ?? false,
    sparseIndexEnabled: false,
    sourceControlIdentity: 'source-control',
    git: {
      run: async (_cwd, args, _signal, _mutation, budget) => {
        const step = remaining.shift()
        if (step === undefined) throw new Error('unexpected Diff command')
        if (step instanceof Error) throw step
        return typeof step === 'function' ? step(args, budget) : step
      },
    },
    assertSourceControlUnchanged: overrides.assertSourceControlUnchanged ?? (async () => {}),
    async [Symbol.asyncDispose]() {},
  }
}

function patchDependencies(
  repository: SafeRepositoryView,
  internals: LocalProjectDiffInternals = {},
  base: LocalProjectDiffDependencies = fakeDependencies({}),
): LocalProjectDiffDependencies {
  const observed = fakeObservation({ commonDirectoryPath: repository.commonDirectoryPath })
  return {
    ...base,
    internals: {
      inspectSelection: async () => fakeStableSelection(observed),
      buildStatus: () => observed.status,
      ...base.internals,
      ...internals,
      openRepository: async () => ({ kind: 'repository', view: repository }),
    },
  }
}

async function readPatchWith(
  repository: SafeRepositoryView,
  path: Buffer,
  signal: AbortSignal,
) {
  const observed = fakeObservation({ commonDirectoryPath: repository.commonDirectoryPath })
  return await readStablePatch(
    patchDependencies(repository),
    fakeBinding({ commonDirectoryPath: repository.commonDirectoryPath }),
    observed,
    path,
    'unstaged',
    signal,
  )
}

function diffRequest(changeId: ProjectGitChangeId) {
  return {
    expectedStatus: { version: 1 as const, digest: 'a'.repeat(64) },
    changeId,
    layer: 'unstaged' as const,
  }
}

function encodeTestCursor(material: {
  readonly observationDigest: string
  readonly changeId: string
  readonly layer: 'staged' | 'unstaged' | 'conflict'
  readonly patchDigest: string
  readonly nextLine: number
}): ProjectGitDiffCursor {
  return Buffer.from(JSON.stringify({ version: 1, ...material }), 'utf8').toString('base64url') as ProjectGitDiffCursor
}

function decodeTestCursor(cursor: ProjectGitDiffCursor): DiffCursorMaterial {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as DiffCursorMaterial
}

async function repository(): Promise<string> {
  const root = await unbornRepository()
  await writeFile(join(root, 'tracked.txt'), 'initial\n')
  await git(root, 'add', '--', 'tracked.txt')
  await git(root, 'commit', '-m', 'initial')
  return root
}

async function unbornRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-diff-'))
  roots.push(root)
  await git(root, 'init', '--initial-branch=main')
  await git(root, 'config', 'user.name', 'Saki Test')
  await git(root, 'config', 'user.email', 'saki@example.invalid')
  await git(root, 'config', 'core.autocrlf', 'false')
  await git(root, 'config', 'commit.gpgSign', 'false')
  return root
}

async function conflictedRepository(): Promise<string> {
  const root = await repository()
  await git(root, 'checkout', '-b', 'other')
  await writeFile(join(root, 'tracked.txt'), 'other\n')
  await git(root, 'commit', '-am', 'other')
  await git(root, 'checkout', 'main')
  await writeFile(join(root, 'tracked.txt'), 'main\n')
  await git(root, 'commit', '-am', 'main')
  return root
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', args, { cwd, windowsHide: true, env: { ...process.env, ...gitInspectionEnvironment() } })
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, ...gitInspectionEnvironment() },
  })).stdout.trim()
}

async function expectGitFailure(cwd: string, ...args: string[]): Promise<void> {
  await expect(run('git', args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, ...gitInspectionEnvironment() },
  })).rejects.toBeDefined()
}

async function register(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
): Promise<ActiveHostProjectBinding> {
  const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
  if (!selected.ok) throw new Error(`selection failed: ${selected.reason}`)
  return {
    id: BINDING_ID,
    revision: 0,
    health: 'active',
    hostId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    expectedInspection: selected.inspection,
    inheritedChangeBaseline: selected.inspection.projection.baseline,
  }
}

async function provider(
  root: string,
  config: Omit<Required<Config>, 'pushCredentialHelper'> & Pick<Config, 'pushCredentialHelper'> = CONFIG,
): Promise<LocalSakiHostExecution> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountLocalHostOperationStorage(ctx, roots)
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('workspaceRegistry', { list: () => [{ id: WORKSPACE_ID, path: root }] })
  await ctx.plugin(LocalSakiHostExecution, config)
  return ctx.sakiHostExecution as LocalSakiHostExecution
}

function observeDiffCommands(execution: LocalSakiHostExecution): string[][] {
  const target = execution as unknown as { git: GitRunner }
  const actual = target.git
  const commands: string[][] = []
  target.git = {
    run: async (...args: Parameters<GitRunner['run']>) => {
      const literal = args[1].indexOf('--literal-pathspecs')
      if (literal >= 0 && args[1].includes('diff')) commands.push([...args[1].slice(literal)])
      return await actual.run(...args)
    },
  } as unknown as GitRunner
  return commands
}

function observeAllCommands(execution: LocalSakiHostExecution): string[][] {
  const target = execution as unknown as { git: GitRunner }
  const actual = target.git
  const commands: string[][] = []
  target.git = {
    run: async (...args: Parameters<GitRunner['run']>) => {
      commands.push([...args[1]])
      return await actual.run(...args)
    },
  } as unknown as GitRunner
  return commands
}

function interceptDiffCommands(
  execution: LocalSakiHostExecution,
  intercept: (
    actual: GitRunner,
    args: Parameters<GitRunner['run']>,
  ) => ReturnType<GitRunner['run']>,
): void {
  const target = execution as unknown as { git: GitRunner }
  const actual = target.git
  target.git = {
    run: async (...args: Parameters<GitRunner['run']>) => args[1].includes('--literal-pathspecs')
      ? await intercept(actual, args)
      : await actual.run(...args),
  } as unknown as GitRunner
}
