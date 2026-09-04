import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  projectGitStatusObservationSchema,
  type SakiHostId,
  type SakiResourceBindingId,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitRunner, gitInspectionEnvironment } from '../src/git-runner.ts'
import LocalSakiHostExecution, { type Config } from '../src/index.ts'
import { completeBoundProjectInspection, projectInspectionFailure } from '../src/inspection-result.ts'
import {
  BoundProjectResourceMismatchError,
  inspectStableLocalProjectSelection,
} from '../src/inspection.ts'
import { ProjectGitStatusProjectionError } from '../src/status.ts'
import { mountLocalHostOperationStorage } from './storage.ts'

const run = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
const BINDING_ID = 'binding-11111111-1111-4111-8111-111111111111' as SakiResourceBindingId
const WORKSPACE_ID = WorkspaceId('workspace-status')
const CONFIG: Omit<Required<Config>, 'pushCredentialHelper'> = {
  gitCommandTimeoutMs: 10_000,
  gitTerminationGraceMs: 100,
  maxGitStdoutBytes: 1024 * 1024,
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

describe('LocalSakiHostExecution project status', () => {
  it.each([
    ['missing', 'missing'],
    ['malformed', 'malformed'],
    ['ambiguous', 'ambiguous'],
    ['unavailable', 'unavailable'],
    ['limit', 'limit'],
    ['unsupported-index-state', 'unavailable'],
    ['not-directory', 'binding-stale'],
    ['not-git', 'binding-stale'],
    ['bare', 'binding-stale'],
    ['prunable', 'binding-stale'],
  ] as const)('projects stable selection failure %s as %s', (reason, expected) => {
    expect(projectInspectionFailure(reason)).toEqual({ ok: false, reason: expected })
  })

  it('completes one stable bound projection and contains only its bounded failures', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return
    const binding = {
      id: BINDING_ID,
      revision: 0,
      health: 'active' as const,
      hostId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      expectedInspection: selected.inspection,
      inheritedChangeBaseline: selected.inspection.projection.baseline,
    }
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok) return
    const material = {
      observation: inspected.observation,
      preEffectBaseline: inspected.preEffectBaseline,
    }

    expect(completeBoundProjectInspection(binding, selected.inspection, () => material)).toEqual(inspected)
    const skippedBuild = vi.fn(() => material)
    expect(completeBoundProjectInspection({
      ...binding,
      hostId: 'host-22222222-2222-4222-8222-222222222222' as SakiHostId,
    }, selected.inspection, skippedBuild)).toEqual({ ok: false, reason: 'binding-stale' })
    expect(skippedBuild).not.toHaveBeenCalled()

    for (const reason of ['invalid-path', 'limit', 'unavailable'] as const) {
      expect(completeBoundProjectInspection(binding, selected.inspection, () => {
        throw new ProjectGitStatusProjectionError(reason)
      })).toEqual({ ok: false, reason })
    }
    const unknown = new Error('unknown projection failure')
    expect(() => completeBoundProjectInspection(binding, selected.inspection, () => { throw unknown }))
      .toThrow(unknown)
  }, 30_000)

  it('returns staged, unstaged, and untracked changes through the bound Host interface', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return

    const statusCommands = observeExecutionStatus(execution)

    await writeFile(join(root, 'tracked.txt'), 'staged\n')
    await git(root, 'add', '--', 'tracked.txt')
    await writeFile(join(root, 'tracked.txt'), 'unstaged\n')
    await writeFile(join(root, 'intent-to-add.txt'), 'intent\n')
    await git(root, 'add', '--intent-to-add', '--', 'intent-to-add.txt')
    await writeFile(join(root, 'untracked.txt'), 'new\n')

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.observation).toMatchObject({
      observationVersion: 1,
      bindingId: BINDING_ID,
      bindingRevision: 0,
      bindingHealth: 'active',
      locked: false,
      objectFormat: 'sha1',
      head: selected.inspection.projection.head,
      branch: { kind: 'attached', ref: 'refs/heads/main', name: 'main' },
      index: { kind: 'tree' },
      worktree: { version: 1 },
      changes: [
        {
          path: 'intent-to-add.txt',
          kind: 'ordinary',
          indexStatus: 'unchanged',
          worktreeStatus: 'added',
          head: { mode: '000000', objectId: '0'.repeat(40) },
          index: { mode: '000000', objectId: '0'.repeat(40) },
          worktreeMode: '100644',
          worktreeEvidence: { kind: 'regular', mode: '100644', byteLength: 7 },
          attribution: 'not-inherited',
        },
        {
          path: 'tracked.txt',
          kind: 'ordinary',
          indexStatus: 'modified',
          worktreeStatus: 'modified',
          worktreeEvidence: { kind: 'regular', mode: '100644', byteLength: 9 },
          attribution: 'not-inherited',
        },
        {
          path: 'untracked.txt',
          kind: 'untracked',
          indexStatus: 'absent',
          worktreeStatus: 'untracked',
          worktreeMode: '100644',
          worktreeEvidence: { kind: 'regular', mode: '100644', byteLength: 4 },
          attribution: 'not-inherited',
        },
      ],
      structuredMutation: { available: true, blockers: [] },
    })
    expect(result.observation.observedAt).toBeGreaterThan(0)
    if (result.observation.index.kind === 'tree') {
      expect(result.observation.index.treeId).toMatch(/^[0-9a-f]{40}$/u)
    }
    expect(result.observation.worktree.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.observation.changes.every(change => change.fingerprint.digest.length === 64)).toBe(true)
    expect(result.observation.fingerprint.version).toBe(1)
    expect(result.observation.fingerprint.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.preEffectBaseline.kind).toBe('complete')
    if (result.preEffectBaseline.kind === 'complete') {
      expect(result.preEffectBaseline.entries.some(entry => entry.statusKind === 'tracked')).toBe(true)
      expect(result.preEffectBaseline.entries.some(entry => entry.statusKind === 'untracked')).toBe(true)
    }
    expect(result.preEffectBaseline).not.toEqual(selected.inspection.projection.baseline)
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('.git')
    expect(statusCommands).toEqual([
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames'],
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames'],
    ])
  }, 30_000)

  it('keeps status readable but blocks mutation when the fresh baseline exceeds its bound', async () => {
    const root = await repository()
    const execution = await provider(root, () => WORKSPACE_ID, { baselineMaxEntries: 1 })
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return
    await writeFile(join(root, 'one.txt'), 'one\n')
    await writeFile(join(root, 'two.txt'), 'two\n')

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result).toMatchObject({
      ok: true,
      preEffectBaseline: { kind: 'unavailable', reason: 'entry-limit' },
      observation: {
        structuredMutation: { available: false, blockers: ['baseline-unavailable'] },
      },
    })
  }, 30_000)

  it('keeps status readable but blocks mutation for assume-unchanged index entries', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    await git(root, 'update-index', '--assume-unchanged', '--', 'tracked.txt')

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result).toMatchObject({
      ok: true,
      observation: {
        changes: [{
          path: 'tracked.txt',
          kind: 'ordinary',
          indexStatus: 'unchanged',
          worktreeStatus: 'modified',
        }],
        structuredMutation: { available: false, blockers: ['index-flags'] },
      },
    })
  }, 30_000)

  it('retains staged and hidden worktree changes together for an assume-unchanged entry', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return
    await writeFile(join(root, 'tracked.txt'), 'staged!!\n')
    await git(root, 'add', '--', 'tracked.txt')
    await writeFile(join(root, 'tracked.txt'), 'hidden!!\n')
    await git(root, 'update-index', '--assume-unchanged', '--', 'tracked.txt')

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result).toMatchObject({
      ok: true,
      observation: {
        changes: [{
          path: 'tracked.txt',
          kind: 'ordinary',
          indexStatus: 'modified',
          worktreeStatus: 'modified',
        }],
        structuredMutation: { available: false, blockers: ['index-flags'] },
      },
    })
  }, 30_000)

  it('keeps status readable but blocks mutation for skip-worktree index entries', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return
    await git(root, 'update-index', '--skip-worktree', '--', 'tracked.txt')

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result).toMatchObject({
      ok: true,
      observation: {
        structuredMutation: { available: false, blockers: ['index-flags'] },
      },
    })
  }, 30_000)

  it.each(['core.sparseCheckout', 'index.sparse'])(
    'keeps status readable but blocks mutation when %s enables sparse index semantics',
    async (configKey) => {
      const root = await repository()
      const execution = await provider(root)
      const signal = new AbortController().signal
      const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
      expect(selected.ok, JSON.stringify(selected)).toBe(true)
      if (!selected.ok) return
      await git(root, 'config', configKey, 'true')

      const result = await execution.inspectProject({
        binding: {
          id: BINDING_ID,
          revision: 0,
          health: 'active',
          hostId: HOST_ID,
          workspaceId: WORKSPACE_ID,
          expectedInspection: selected.inspection,
          inheritedChangeBaseline: selected.inspection.projection.baseline,
        },
      }, signal)

      expect(result).toMatchObject({
        ok: true,
        observation: {
          structuredMutation: { available: false, blockers: ['index-flags'] },
        },
      })
    },
    30_000,
  )

  it('keeps index-flag reads inside the stable private repository view', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return
    const target = execution as unknown as { git: GitRunner }
    const actual = target.git
    let flagQueries = 0
    let bareFlagQueries = 0
    target.git = {
      run: async (...args: Parameters<GitRunner['run']>) => {
        const command = args[1]
        const isFlagQuery = command.slice(-4).join('\0') === ['ls-files', '-v', '-z', '--'].join('\0')
        const output = await actual.run(...args)
        if (isFlagQuery) {
          flagQueries += 1
          if (!command.some(argument => argument.startsWith('--git-dir='))) bareFlagQueries += 1
          if (flagQueries === 1) {
            await git(root, 'update-index', '--assume-unchanged', '--', 'tracked.txt')
          }
        }
        return output
      },
    } as unknown as GitRunner

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'ambiguous' })
    expect(flagQueries).toBe(1)
    expect(bareFlagQueries).toBe(0)
  }, 30_000)

  it('expands sparse-directory inventory for readable status while mutation remains blocked', async () => {
    const root = await repository()
    await mkdir(join(root, 'kept'))
    await mkdir(join(root, 'omitted'))
    await writeFile(join(root, 'kept', 'visible.txt'), 'visible\n')
    await writeFile(join(root, 'omitted', 'hidden.txt'), 'hidden\n')
    await git(root, 'add', '--', 'kept', 'omitted')
    await git(root, 'commit', '-m', 'add sparse directories')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return
    await git(root, 'sparse-checkout', 'init', '--cone', '--sparse-index')
    await git(root, 'sparse-checkout', 'set', 'kept')
    expect(await gitText(root, 'ls-files', '--sparse', '--stage', '--', 'omitted')).toContain('040000')

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result).toMatchObject({
      ok: true,
      observation: {
        structuredMutation: { available: false, blockers: ['index-flags'] },
      },
    })
  }, 45_000)

  it('retains the porcelain worktree mode when Git materializes a symlink as a regular file', async () => {
    const root = await repository()
    await git(root, 'config', 'core.symlinks', 'false')
    await writeFile(join(root, 'symlink-source.txt'), 'target\n')
    const objectId = await gitText(root, 'hash-object', '-w', '--', 'symlink-source.txt')
    await rm(join(root, 'symlink-source.txt'))
    await git(root, 'update-index', '--add', '--cacheinfo', `120000,${objectId},link`)
    await git(root, 'checkout-index', '-f', '--', 'link')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    const link = result.observation.changes.find(change => change.path === 'link')
    expect(link).toMatchObject({
      path: 'link',
      kind: 'ordinary',
      indexStatus: 'added',
      worktreeStatus: 'unchanged',
      index: { mode: '120000', objectId },
      worktreeMode: '120000',
      worktreeEvidence: { kind: 'regular', mode: '100644', byteLength: 7 },
    })
    expect(projectGitStatusObservationSchema.parse(result.observation)).toEqual(result.observation)
  }, 30_000)

  it('pins a loose upstream ref and retains its exact ahead/behind divergence', async () => {
    const root = await repository()
    await git(root, 'checkout', '-b', 'remote-side')
    await writeFile(join(root, 'remote.txt'), 'remote\n')
    await git(root, 'add', '--', 'remote.txt')
    await git(root, 'commit', '-m', 'remote side')
    const remoteHead = await gitText(root, 'rev-parse', 'HEAD')
    await git(root, 'checkout', 'main')
    await writeFile(join(root, 'local.txt'), 'local\n')
    await git(root, 'add', '--', 'local.txt')
    await git(root, 'commit', '-m', 'local side')
    await git(root, 'update-ref', 'refs/remotes/origin/main', remoteHead)
    await git(root, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
    await git(root, 'config', 'branch.main.remote', 'origin')
    await git(root, 'config', 'branch.main.merge', 'refs/heads/main')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.observation.upstream).toEqual({
      ref: 'refs/remotes/origin/main',
      name: 'origin/main',
      divergence: { ahead: 1, behind: 1 },
    })
  }, 30_000)

  it('retains deletions, type changes, unmerged stages, and gitlink submodule facts', async () => {
    const root = await repository()
    await git(root, 'config', 'core.symlinks', 'false')
    await writeFile(join(root, 'conflicted.txt'), 'base\n')
    await writeFile(join(root, 'delete.txt'), 'delete\n')
    await writeFile(join(root, 'type.txt'), 'type\n')
    await git(root, 'add', '--', 'conflicted.txt', 'delete.txt', 'type.txt')
    await git(root, 'commit', '-m', 'status fixtures')
    await git(root, 'checkout', '-b', 'incoming')
    await writeFile(join(root, 'conflicted.txt'), 'incoming\n')
    await git(root, 'add', '--', 'conflicted.txt')
    await git(root, 'commit', '-m', 'incoming conflict')
    await git(root, 'checkout', 'main')
    await writeFile(join(root, 'conflicted.txt'), 'local\n')
    await git(root, 'add', '--', 'conflicted.txt')
    await git(root, 'commit', '-m', 'local conflict')
    await expect(gitResult(root, 'merge', '--no-edit', 'incoming')).rejects.toBeDefined()
    await rm(join(root, 'delete.txt'))
    const typeObject = await gitText(root, 'rev-parse', 'HEAD:type.txt')
    await git(root, 'update-index', '--cacheinfo', `120000,${typeObject},type.txt`)
    const commit = await gitText(root, 'rev-parse', 'HEAD')
    await git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},module`)
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.observation.index).toMatchObject({
      kind: 'unmerged',
      stagesDigest: { version: 1 },
    })
    if (result.observation.index.kind === 'unmerged') {
      expect(result.observation.index.stagesDigest.digest).toMatch(/^[0-9a-f]{64}$/u)
    }
    expect(result.observation.structuredMutation).toEqual({ available: false, blockers: ['unmerged'] })
    expect(projectGitStatusObservationSchema.parse(result.observation)).toEqual(result.observation)
    const changesByPath = new Map(result.observation.changes.map(change => [change.path, change]))
    expect(changesByPath.get('conflicted.txt')).toMatchObject({
      path: 'conflicted.txt',
      kind: 'unmerged',
      conflict: 'both-modified',
      worktreeStatus: 'present',
      worktreeMode: '100644',
      stages: {
        base: { mode: '100644' },
        ours: { mode: '100644' },
        theirs: { mode: '100644' },
      },
    })
    expect(changesByPath.get('delete.txt')).toMatchObject({
      path: 'delete.txt',
      kind: 'ordinary',
      indexStatus: 'unchanged',
      worktreeStatus: 'deleted',
      worktreeMode: '000000',
      worktreeEvidence: { kind: 'missing' },
    })
    expect(changesByPath.get('module')).toMatchObject({
      path: 'module',
      kind: 'ordinary',
      indexStatus: 'added',
      worktreeStatus: 'deleted',
      submodule: {
        kind: 'submodule',
        commit: 'unknown',
      },
      index: { mode: '160000', objectId: commit },
      worktreeMode: '000000',
    })
    expect(changesByPath.get('type.txt')).toMatchObject({
      path: 'type.txt',
      kind: 'ordinary',
      indexStatus: 'type-changed',
      head: { mode: '100644', objectId: typeObject },
      index: { mode: '120000', objectId: typeObject },
      worktreeMode: '120000',
      worktreeEvidence: { kind: 'regular', mode: '100644' },
    })
    const conflict = changesByPath.get('conflicted.txt')
    expect(conflict?.kind).toBe('unmerged')
    if (conflict?.kind === 'unmerged') {
      expect(conflict.stages.base.objectId).toMatch(/^[0-9a-f]{40}$/u)
      expect(conflict.stages.ours.objectId).toMatch(/^[0-9a-f]{40}$/u)
      expect(conflict.stages.theirs.objectId).toMatch(/^[0-9a-f]{40}$/u)
    }
  }, 30_000)

  it.each(['clean', 'process'] as const)('does not execute a repository %s filter while observing status', async (filterKind) => {
    const root = await repository()
    const marker = join(root, 'status-filter-ran')
    const script = join(root, 'status-filter-sentinel.cjs')
    const ownerNonce = randomUUID()
    await writeFile(
      script,
      'if (process.env.SAKI_STATUS_FILTER_TEST_OWNER === process.argv[3]) '
      + 'require("node:fs").writeFileSync(process.argv[2], "ran"); process.stdin.pipe(process.stdout)\n',
    )
    await writeFile(join(root, '.gitattributes'), 'tracked.txt filter=status-sentinel\n')
    await git(root, 'add', '--', '.gitattributes', 'status-filter-sentinel.cjs')
    await git(root, 'commit', '-m', 'add status filter declaration')
    const filterCommand = [process.execPath, script, marker, ownerNonce]
      .map(value => `'${value.replaceAll("'", "'\"'\"'")}'`)
      .join(' ')
    await git(root, 'config', `filter.status-sentinel.${filterKind}`, filterCommand)
    await git(root, 'config', 'filter.status-sentinel.required', 'true')
    const previousOwner = process.env.SAKI_STATUS_FILTER_TEST_OWNER
    process.env.SAKI_STATUS_FILTER_TEST_OWNER = ownerNonce
    try {
      const directFilter = git(root, 'hash-object', '--path=tracked.txt', '--', 'tracked.txt')
      if (filterKind === 'clean') await expect(directFilter).resolves.toBeUndefined()
      else await expect(directFilter).rejects.toBeDefined()
      await expect(access(marker)).resolves.toBeUndefined()
      await rm(marker)

      const execution = await provider(root)
      const signal = new AbortController().signal
      const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
      expect(selected.ok, JSON.stringify(selected)).toBe(true)
      if (!selected.ok) return
      await writeFile(join(root, 'tracked.txt'), 'changed\n')

      const result = await execution.inspectProject({
        binding: {
          id: BINDING_ID,
          revision: 0,
          health: 'active',
          hostId: HOST_ID,
          workspaceId: WORKSPACE_ID,
          expectedInspection: selected.inspection,
          inheritedChangeBaseline: selected.inspection.projection.baseline,
        },
      }, signal)

      expect(result).toMatchObject({
        ok: true,
        observation: {
          changes: [{
            path: 'tracked.txt',
            kind: 'ordinary',
            indexStatus: 'unchanged',
            worktreeStatus: 'modified',
          }],
        },
      })
      expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('changed\n')
      await expect(access(marker)).rejects.toBeDefined()
    } finally {
      if (previousOwner === undefined) delete process.env.SAKI_STATUS_FILTER_TEST_OWNER
      else process.env.SAKI_STATUS_FILTER_TEST_OWNER = previousOwner
    }
  }, 30_000)

  it('rejects a replaced bound repository before scanning its inventory', async () => {
    const root = await repository()
    const replacement = await repository()
    const displacedGit = `${root}-bound-git`
    roots.push(displacedGit)
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return

    await rename(join(root, '.git'), displacedGit)
    await rename(join(replacement, '.git'), join(root, '.git'))
    const inventoryCommands = observeExecutionInventory(execution)

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'binding-stale' })
    expect(inventoryCommands).toEqual([])
  }, 30_000)

  it('rejects a changed bound Workspace before scanning repository inventory', async () => {
    const root = await repository()
    let currentWorkspaceId = WORKSPACE_ID
    const execution = await provider(root, () => currentWorkspaceId)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return

    currentWorkspaceId = WorkspaceId('workspace-reassigned')
    const inventoryCommands = observeExecutionInventory(execution)

    const result = await execution.inspectProject({
      binding: {
        id: BINDING_ID,
        revision: 0,
        health: 'active',
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        expectedInspection: selected.inspection,
        inheritedChangeBaseline: selected.inspection.projection.baseline,
      },
    }, signal)

    expect(result).toEqual({ ok: false, reason: 'binding-stale' })
    expect(inventoryCommands).toEqual([])
  }, 30_000)

  it('revalidates a bound identity before the second inventory observation', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
    expect(selected.ok, JSON.stringify(selected)).toBe(true)
    if (!selected.ok) return

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(LocalSubprocessRuntime)
    const executable = await ctx.subprocess.resolveExecutable('git')
    const actual = new GitRunner(ctx.subprocess, executable, {
      maxStdoutBytes: CONFIG.maxGitStdoutBytes,
      maxStderrBytes: CONFIG.maxGitStderrBytes,
      timeoutMs: CONFIG.gitCommandTimeoutMs,
      terminationGraceMs: CONFIG.gitTerminationGraceMs,
    })
    let inventoryRounds = 0
    const observed = {
      run: async (...args: Parameters<GitRunner['run']>) => {
        if (args[1].includes('ls-tree')) inventoryRounds += 1
        return await actual.run(...args)
      },
    } as unknown as GitRunner
    let identityReads = 0

    await expect(inspectStableLocalProjectSelection(
      ctx.fs,
      {
        list: () => [{
          id: WORKSPACE_ID,
          path: selected.inspection.trusted.canonicalWorktreePath,
        }],
      },
      observed,
      CONFIG,
      { hostId: HOST_ID, directoryLocator: root },
      signal,
      async () => identityReads++ === 0
        ? selected.inspection.trusted.gitDirectoryIdentity
        : { version: 1, digest: 'f'.repeat(64) },
      {
        boundResource: {
          workspaceId: WORKSPACE_ID,
          trusted: selected.inspection.trusted,
        },
      },
    )).rejects.toBeInstanceOf(BoundProjectResourceMismatchError)
    expect(inventoryRounds).toBe(1)
    expect(identityReads).toBe(2)
  }, 30_000)
})

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-status-'))
  roots.push(root)
  await git(root, 'init', '--initial-branch=main')
  await git(root, 'config', 'user.name', 'Saki Test')
  await git(root, 'config', 'user.email', 'saki@example.invalid')
  await git(root, 'config', 'core.autocrlf', 'false')
  await git(root, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(root, 'tracked.txt'), 'initial\n')
  await git(root, 'add', '--', 'tracked.txt')
  await git(root, 'commit', '-m', 'initial')
  return root
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', args, { cwd, windowsHide: true, env: { ...process.env, ...gitInspectionEnvironment() } })
}

async function gitResult(cwd: string, ...args: string[]) {
  return await run('git', args, { cwd, windowsHide: true, env: { ...process.env, ...gitInspectionEnvironment() } })
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitResult(cwd, ...args)
  return result.stdout.trim()
}

function observeExecutionInventory(execution: LocalSakiHostExecution): string[][] {
  const target = execution as unknown as { git: GitRunner }
  const actual = target.git
  const commands: string[][] = []
  target.git = {
    run: async (...args: Parameters<GitRunner['run']>) => {
      if (args[1].includes('ls-tree') || args[1].includes('ls-files')) commands.push([...args[1]])
      return await actual.run(...args)
    },
  } as unknown as GitRunner
  return commands
}

function observeExecutionStatus(execution: LocalSakiHostExecution): string[][] {
  const target = execution as unknown as { git: GitRunner }
  const actual = target.git
  const commands: string[][] = []
  target.git = {
    run: async (...args: Parameters<GitRunner['run']>) => {
      const status = args[1].indexOf('status')
      if (status >= 0) commands.push(args[1].slice(status))
      return await actual.run(...args)
    },
  } as unknown as GitRunner
  return commands
}

async function provider(
  root: string,
  currentWorkspaceId: () => typeof WORKSPACE_ID = () => WORKSPACE_ID,
  config: Partial<Required<Config>> = {},
): Promise<LocalSakiHostExecution> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountLocalHostOperationStorage(ctx, roots)
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('workspaceRegistry', { list: () => [{ id: currentWorkspaceId(), path: root }] })
  await ctx.plugin(LocalSakiHostExecution, { ...CONFIG, ...config })
  return ctx.sakiHostExecution as LocalSakiHostExecution
}
