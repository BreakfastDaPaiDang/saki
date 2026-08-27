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
  MAX_PROJECT_GIT_DIFF_PAGE_LINES,
  MAX_PROJECT_GIT_DIFF_PAGE_UTF8_BYTES,
  MAX_PROJECT_GIT_DIFF_TOTAL_LINES,
} from '@breakfastdapaidang/saki-execution'
import type {
  ActiveHostProjectBinding,
  ProjectGitChangeId,
  ProjectGitDiffCursor,
  SakiHostId,
  SakiResourceBindingId,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it } from 'vitest'
import { projectDiffCommandFits } from '../src/diff.ts'
import { GitCommandError, GitRunner, gitInspectionEnvironment } from '../src/git-runner.ts'
import { LocalSakiHostExecution, type Config } from '../src/index.ts'
import { mountLocalHostOperationStorage } from './storage.ts'

const run = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
const BINDING_ID = 'binding-11111111-1111-4111-8111-111111111111' as SakiResourceBindingId
const WORKSPACE_ID = WorkspaceId('workspace-diff')
const CONFIG: Required<Config> = {
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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
      .map(value => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`)
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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

  it('rejects provider-resolved paths outside portable command-line bounds', () => {
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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)

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
  }, 30_000)
})

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
  config: Required<Config> = CONFIG,
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
