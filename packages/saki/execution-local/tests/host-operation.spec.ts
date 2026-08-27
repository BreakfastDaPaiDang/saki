import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { hostOperationChangeSchema, MAX_GIT_REF_CHARS } from '@breakfastdapaidang/saki-execution'
import type {
  ActiveHostProjectBinding,
  CommitHostOperationRequest,
  HostOperationAdmissionSource,
  SakiControlIntentId,
  SakiHostId,
  SakiResourceBindingId,
  StageFilesHostOperationRequest,
  UnstageFilesHostOperationRequest,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitCommandError, type GitRunner } from '../src/git-runner.ts'
import LocalSakiHostExecution, {
  MIN_OPERATION_MAX_INDEX_BYTES,
  sakiHostExecutionDomainSpec,
  type Config,
} from '../src/index.ts'
import {
  localHostOperationRequestFingerprint,
  type LocalHostOperationRecord,
} from '../src/operation-state.ts'

const run = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
const BINDING_ID = 'binding-11111111-1111-4111-8111-111111111111' as SakiResourceBindingId
const INTENT_ID = 'intent-11111111-1111-4111-8111-111111111111' as SakiControlIntentId
const WORKSPACE_ID = WorkspaceId('workspace-host-operation')
const CONFIG: Required<Config> = {
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
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('LocalSakiHostExecution Host Operation lifecycle', () => {
  it('prepares one inert durable operation, replays it exactly, and cancels before effect', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete') return
    const change = inspected.observation.changes[0]
    expect(change).toBeDefined()
    if (change === undefined || inspected.observation.index.kind !== 'tree') return
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '1'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const admit = vi.fn<HostOperationAdmissionSource>()
    const changes: unknown[] = []
    const dispose = execution.onChanged(change => changes.push(change))

    const first = await execution.prepareOperation(request, admit, signal)
    expect(first).toMatchObject({
      ok: true,
      preparation: {
        operation: {
          id: 'host-operation-11111111-1111-4111-8111-111111111111',
          hostId: HOST_ID,
          type: 'stage-files',
        },
        preparationRevision: 0,
        requestFingerprint: { version: 1 },
      },
      snapshot: { state: 'prepared', revision: 0, admission: { kind: 'not-accepted' } },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(admit).not.toHaveBeenCalled()
    expect(changes).toHaveLength(1)
    expect(() => hostOperationChangeSchema.parse(changes[0])).not.toThrow()
    if (!first.ok) return

    const replay = await execution.prepareOperation(request, admit, signal)
    expect(replay).toMatchObject({
      ok: true,
      preparation: first.preparation,
      snapshot: first.snapshot,
    })
    expect(changes).toHaveLength(1)

    const changedReplay = await execution.prepareOperation({
      ...request,
      expected: { ...request.expected, binding: { ...binding, revision: 1 } },
    }, admit, signal)
    expect(changedReplay).toEqual({ ok: false, reason: 'source-conflict' })

    const canceled = await execution.cancelOperation(
      first.preparation.operation,
      'source-canceled',
      signal,
    )
    expect(canceled).toMatchObject({
      state: 'canceled',
      revision: 1,
      admission: { kind: 'not-accepted' },
      reason: 'source-canceled',
      effect: 'none',
    })
    expect(changes).toHaveLength(2)
    dispose()
  }, 30_000)

  it('publishes one selected worktree change through an alternate index', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete') return
    const change = inspected.observation.changes[0]
    if (change === undefined || inspected.observation.index.kind !== 'tree') return
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '2'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const admission: HostOperationAdmissionSource = () => Promise.resolve({
      kind: 'accepted',
      admissionRevision: 7,
    })
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        admission: { kind: 'accepted', revision: 7 },
        result: {
          type: 'stage-files',
          changes: [{ id: change.id, path: 'tracked.txt' }],
          resultingIndex: { kind: 'tree' },
        },
      },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    expect(liveOperationCount(execution)).toBe(0)
    const terminalReplay = await execution.prepareOperation(request, admission, signal)
    expect(terminalReplay.ok).toBe(true)
    expect(liveOperationCount(execution)).toBe(0)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toEqual(started.snapshot)
    expect(liveOperationCount(execution)).toBe(0)
    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toEqual(started)
  }, 30_000)

  it('restores one selected index change from HEAD without changing the worktree', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    await git(root, 'add', '--', 'tracked.txt')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete') return
    const change = inspected.observation.changes[0]
    if (change === undefined || inspected.observation.index.kind !== 'tree') return
    const request: UnstageFilesHostOperationRequest = {
      type: 'unstage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '3'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const admission: HostOperationAdmissionSource = () => Promise.resolve({
      kind: 'accepted',
      admissionRevision: 8,
    })
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
        throw new Error('simulated Unstage plan acknowledgement loss')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated Unstage plan acknowledgement loss')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Unstage plan')
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).resolves.toBeDefined()

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'unstage-files',
          changes: [{ id: change.id, path: 'tracked.txt' }],
          resultingIndex: { kind: 'tree' },
        },
      },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(await gitText(root, 'diff', '--name-only')).toBe('tracked.txt')
  }, 30_000)

  it('does not publish an Unstage when the caller aborts during write admission', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'caller-abort\n')
    await git(root, 'add', '--', 'tracked.txt')
    const execution = await provider(root)
    const setupSignal = new AbortController().signal
    const binding = await activeBinding(execution, root, setupSignal)
    const inspected = await execution.inspectProject({ binding }, setupSignal)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') {
      throw new Error(`test repository was not mutable: ${JSON.stringify(inspected)}`)
    }
    const change = inspected.observation.changes[0]
    if (change === undefined) throw new Error('test repository had no staged path')
    const request: UnstageFilesHostOperationRequest = {
      type: 'unstage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: 'd'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const caller = new AbortController()
    const callerReason = new Error('caller stopped the Unstage start')
    const admission: HostOperationAdmissionSource = () => {
      caller.abort(callerReason)
      return Promise.resolve({ kind: 'accepted', admissionRevision: 24 })
    }
    const prepared = await execution.prepareOperation(request, admission, setupSignal)
    if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const stagedTree = await gitText(root, 'write-tree')

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      caller.signal,
    )).rejects.toBe(callerReason)

    expect(await execution.inspectOperation(prepared.preparation.operation, setupSignal)).toMatchObject({
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'write-tree')).toBe(stagedTree)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 45_000)

  it.each([
    ['Stage', 'stage-files'],
    ['Unstage', 'unstage-files'],
  ] as const)('fails %s before effect when accepted index evidence drifts', async (_label, operationType) => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    if (operationType === 'unstage-files') await git(root, 'add', '--', 'tracked.txt')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') return
    const change = inspected.observation.changes[0]
    if (change === undefined) throw new Error('test repository had no changed path')
    const common = {
      source: {
        kind: 'control-intent' as const,
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '4'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const request: StageFilesHostOperationRequest | UnstageFilesHostOperationRequest
      = operationType === 'stage-files'
        ? { type: 'stage-files', ...common }
        : { type: 'unstage-files', ...common }
    const prepared = await execution.prepareOperation(
      request,
      () => Promise.resolve({ kind: 'accepted', admissionRevision: 9 }),
      signal,
    )
    if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)
    await writeFile(join(root, 'index-drift.txt'), 'external index change\n')
    await git(root, 'add', '--', 'index-drift.txt')
    const externallyChangedTree = await gitText(root, 'write-tree')

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'observation-stale' },
        effect: 'none',
      },
    })
    expect(liveOperationCount(execution)).toBe(0)
    expect(await gitText(root, 'write-tree')).toBe(externallyChangedTree)
    expect(await gitText(root, 'diff', '--cached', '--name-only', '--', 'tracked.txt')).toBe(
      operationType === 'stage-files' ? '' : 'tracked.txt',
    )
  }, 45_000)

  it('rejects a Stage when the bound Git directory identity is replaced after preparation', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, 'b', 22)
    await rename(join(root, '.git'), join(root, '.git-replaced'))
    await git(root, 'init', '--quiet', '--initial-branch=main')
    await git(root, 'config', 'user.name', 'Replacement')
    await git(root, 'config', 'user.email', 'replacement@example.invalid')
    await git(root, 'add', '--', 'tracked.txt')
    await git(root, 'commit', '--quiet', '-m', 'replacement repository')
    const replacementHead = await gitText(root, 'rev-parse', 'HEAD')
    const replacementIndex = await gitText(root, 'write-tree')

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: { state: 'failed', failure: { reason: 'binding-stale' }, effect: 'none' },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(replacementHead)
    expect(await gitText(root, 'write-tree')).toBe(replacementIndex)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 45_000)

  it.skipIf(process.platform === 'win32')(
    'stages a filename containing newline and tab bytes through its Host-resolved selection',
    async () => {
      const root = await repository()
      const execution = await provider(root)
      const signal = new AbortController().signal
      const binding = await activeBinding(execution, root, signal)
      const path = 'line\nbreak\tname.txt'
      await writeFile(join(root, path), 'NUL-safe path\n')
      const inspected = await execution.inspectProject({ binding }, signal)
      expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
      if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
        || inspected.observation.index.kind !== 'tree') return
      const change = inspected.observation.changes.find(candidate => candidate.path === path)
      if (change === undefined) throw new Error('test status did not preserve the exact filename')
      const request: StageFilesHostOperationRequest = {
        type: 'stage-files',
        source: {
          kind: 'control-intent',
          intentId: INTENT_ID,
          intentRevision: 2,
          payloadDigest: '0'.repeat(64),
        },
        expected: {
          binding,
          status: inspected.observation.fingerprint,
          head: inspected.observation.head,
          index: inspected.observation.index,
          worktree: inspected.observation.worktree,
          preEffectBaseline: inspected.preEffectBaseline,
        },
        changes: [{ id: change.id, fingerprint: change.fingerprint }],
      }
      const prepared = await execution.prepareOperation(
        request,
        () => Promise.resolve({ kind: 'accepted', admissionRevision: 9 }),
        signal,
      )
      if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)

      const started = await execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )

      expect(started).toMatchObject({
        ok: true,
        snapshot: {
          state: 'succeeded',
          result: { type: 'stage-files', changes: [{ id: change.id, path }] },
        },
      })
      expect(await gitText(root, 'ls-files', '-z', '--', path)).toBe(`${path}\0`)
    },
    45_000,
  )

  it('keeps a foreign index lock retryable and publishes after the lock clears', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete') return
    const change = inspected.observation.changes[0]
    if (change === undefined || inspected.observation.index.kind !== 'tree') return
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '4'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const admission: HostOperationAdmissionSource = () => Promise.resolve({
      kind: 'accepted',
      admissionRevision: 9,
    })
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const lockPath = join(root, '.git', 'index.lock')
    await writeFile(lockPath, 'foreign lock\n', { flag: 'wx' })

    const busy = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(busy).toMatchObject({ ok: false, reason: 'busy', snapshot: { state: 'planning' } })
    expect(await readFile(lockPath, 'utf8')).toBe('foreign lock\n')
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    await unlink(lockPath)

    const retried = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    expect(retried, JSON.stringify(retried)).toMatchObject({
      ok: true,
      snapshot: { state: 'succeeded', result: { type: 'stage-files' } },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 45_000)

  it('does not reuse or delete a pre-plan pin residue from the same operation', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '4', 9)
    const residue = join(
      root,
      '.git',
      `index.saki-${prepared.preparation.operation.id}-${'a'.repeat(32)}.pin`,
    )
    await writeFile(residue, 'pre-plan residue\n', { flag: 'wx' })

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await readFile(residue, 'utf8')).toBe('pre-plan residue\n')
  }, 60_000)

  it('preserves the existing shared index permission bits during Stage publication', async () => {
    const root = await repository()
    const indexPath = join(root, '.git', 'index')
    const requestedMode = process.platform === 'win32' ? 0o666 : 0o640
    await chmod(indexPath, requestedMode)
    const expectedMode = Number((await stat(indexPath, { bigint: true })).mode & 0o777n)
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '4', 9)

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(Number((await stat(indexPath, { bigint: true })).mode & 0o777n)).toBe(expectedMode)
  }, 60_000)

  it('creates a missing shared index with the Git-style umask mode', async () => {
    const root = await unbornRepository()
    await writeFile(join(root, 'first.txt'), 'first\n')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const inspected = await execution.inspectProject({ binding }, signal)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') {
      throw new Error(`test repository was not mutable: ${JSON.stringify(inspected)}`)
    }
    const change = inspected.observation.changes.find(candidate => candidate.path === 'first.txt')
    if (change === undefined) throw new Error('test repository exposed no untracked file')
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '4'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const prepared = await execution.prepareOperation(
      request,
      () => Promise.resolve({ kind: 'accepted', admissionRevision: 9 }),
      signal,
    )
    if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)
    await expect(stat(join(root, '.git', 'index'))).rejects.toMatchObject({ code: 'ENOENT' })
    const modeProbePath = join(root, '.git', 'mode-probe')
    await (await open(modeProbePath, 'wx', 0o666)).close()
    const expectedMode = Number((await stat(modeProbePath, { bigint: true })).mode & 0o777n)
    await unlink(modeProbePath)

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(Number((await stat(join(root, '.git', 'index'), { bigint: true })).mode & 0o777n)).toBe(expectedMode)
  }, 60_000)

  it('fails before effect when unsupported index flags appear after prepare', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete') return
    const change = inspected.observation.changes[0]
    if (change === undefined || inspected.observation.index.kind !== 'tree') return
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '5'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }
    const admission: HostOperationAdmissionSource = () => Promise.resolve({
      kind: 'accepted',
      admissionRevision: 10,
    })
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    await git(root, 'update-index', '--assume-unchanged', '--', 'tracked.txt')

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
  }, 30_000)

  it('rejects a selected path whose directory-file conflict depends on an unselected index change', async () => {
    const root = await repository()
    await writeFile(join(root, 'slot'), 'file\n')
    await git(root, 'add', '--', 'slot')
    await git(root, 'commit', '-m', 'add file-shaped slot')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await unlink(join(root, 'slot'))
    await mkdir(join(root, 'slot'))
    await writeFile(join(root, 'slot', 'child.txt'), 'child\n')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') return
    const child = inspected.observation.changes.find(change => change.path === 'slot/child.txt')
    if (child === undefined) throw new Error('test status did not expose the child path')
    const request: StageFilesHostOperationRequest = {
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '6'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      changes: [{ id: child.id, fingerprint: child.fingerprint }],
    }
    const prepared = await execution.prepareOperation(
      request,
      () => Promise.resolve({ kind: 'accepted', admissionRevision: 11 }),
      signal,
    )
    if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
  }, 45_000)

  it('inspection never resumes a durable not-started publication and cancellation proves no effect', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
      }
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated crash before attempting evidence became durable')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable index plan')
    const lockPath = join(root, '.git', 'index.lock')
    await link(durable.effectPlan.pin.path, lockPath)

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'publishing',
    })
    await expect(stat(lockPath)).resolves.toBeDefined()
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 45_000)

  it('preserves a same-content foreign lock that replaced a durable Stage hard link', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
      }
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated crash before Stage attempt became durable')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash before Stage attempt became durable')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable index plan')
    const lockPath = join(root, '.git', 'index.lock')
    const pinBytes = await readFile(durable.effectPlan.pin.path)
    await writeFile(lockPath, pinBytes, { flag: 'wx', mode: durable.effectPlan.pin.mode })
    const foreign = await stat(lockPath, { bigint: true })
    expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).not.toEqual(
      durable.effectPlan.pin.identity,
    )

    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none' })
    await expect(readFile(lockPath)).resolves.toEqual(pinBytes)
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await unlink(lockPath)
  }, 60_000)

  it('keeps a grown owned index hard link non-terminal until exact evidence is restored', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
        && record.effectPlan.publication === 'not-started') {
        durable = record
        throw new Error('captured durable Stage pin before attempt')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('captured durable Stage pin before attempt')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
    const pin = durable.effectPlan.pin
    const pinBytes = await readFile(pin.path)
    const lockPath = join(root, '.git', 'index.lock')
    await link(pin.path, lockPath)
    await writeFile(lockPath, Buffer.from([0]), { flag: 'a' })
    expect((await stat(lockPath)).size).toBe(pin.byteLength + 1)

    await expect(execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).rejects.toThrow('temporarily unavailable')
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'publishing',
    })
    expect((await stat(lockPath)).size).toBe(pin.byteLength + 1)
    expect((await stat(pin.path)).size).toBe(pin.byteLength + 1)

    await writeFile(lockPath, pinBytes)
    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none' })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it.each(['absent', 'foreign'] as const)(
    'cancels with a lowered index bound when the blocking lock is %s',
    async (lockState) => {
      const root = await repository()
      await writeFile(join(root, 'second.txt'), 'second tracked file\n')
      await git(root, 'add', '--', 'second.txt')
      await git(root, 'commit', '-m', 'expand index')
      const execution = await provider(root)
      const signal = new AbortController().signal
      const selectedPath = `untracked-${'x'.repeat(180)}.txt`
      const { prepared } = await preparedStage(execution, root, signal, '6', 11, selectedPath)
      const persistence = operationPersistence(execution)
      let durable: LocalHostOperationRecord | undefined
      persistence.replace(async (record) => {
        await persistence.original(record)
        if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'index'
          && record.effectPlan.publication === 'not-started') {
          durable = record
          throw new Error('captured durable Stage plan before lowering the bound')
        }
      })

      await expect(execution.startOperation(
        prepared.preparation.operation,
        prepared.acceptance,
        signal,
      )).rejects.toThrow('captured durable Stage plan before lowering the bound')
      persistence.restore()
      if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable Stage plan')
      const pin = durable.effectPlan.pin
      if (durable.effectPlan.expectedIndexFile.kind !== 'file') throw new Error('test retained no source index')
      const loweredBound = durable.effectPlan.expectedIndexFile.byteLength
      expect(loweredBound).toBeGreaterThanOrEqual(MIN_OPERATION_MAX_INDEX_BYTES)
      expect(pin.byteLength).toBeGreaterThan(loweredBound)
      const runtime = execution as unknown as { config: { operationMaxIndexBytes: number } }
      const originalBound = runtime.config.operationMaxIndexBytes
      runtime.config.operationMaxIndexBytes = loweredBound
      const lockPath = join(root, '.git', 'index.lock')
      if (lockState === 'foreign') {
        await writeFile(lockPath, await readFile(pin.path), { flag: 'wx', mode: pin.mode })
        const foreign = await stat(lockPath, { bigint: true })
        expect({ device: foreign.dev.toString(), inode: foreign.ino.toString() }).not.toEqual(pin.identity)
      }

      expect(await execution.cancelOperation(
        prepared.preparation.operation,
        'source-canceled',
        signal,
      )).toMatchObject({ state: 'canceled', effect: 'none' })
      if (lockState === 'absent') {
        await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        await expect(readFile(lockPath)).resolves.toEqual(await readFile(pin.path))
      }
      await expect(stat(pin.path)).resolves.toBeDefined()

      runtime.config.operationMaxIndexBytes = originalBound
      expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
        state: 'canceled',
      })
      await expect(stat(pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
      if (lockState === 'foreign') await unlink(lockPath)
    },
    60_000,
  )

  it('removes a Stage scratch when the first effect-plan persistence fails', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const persistence = operationPersistence(execution)
    let scratchPath: string | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        scratchPath = record.effectPlan.scratch.path
        throw new Error('simulated first Stage plan persistence failure')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated first Stage plan persistence failure')
    persistence.restore()
    expect(scratchPath).toBeDefined()
    if (scratchPath === undefined) return
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('keeps a staged blob private until its durable publication plan exists', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const objectId = await gitText(root, 'hash-object', '--no-filters', 'tracked.txt')
    await expect(run('git', ['cat-file', '-e', objectId], {
      cwd: root,
      windowsHide: true,
    })).rejects.toBeDefined()
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
        throw new Error('simulated crash after durable private Stage plan')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash after durable private Stage plan')
    persistence.restore()
    await expect(run('git', ['cat-file', '-e', objectId], {
      cwd: root,
      windowsHide: true,
    })).rejects.toBeDefined()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no durable index plan')
    expect(durable.effectPlan).toHaveProperty('pin')
    const pin = durable.effectPlan.pin
    const pinInfo = await stat(pin.path, { bigint: true })
    expect({ device: pinInfo.dev.toString(), inode: pinInfo.ino.toString() }).toEqual(pin.identity)
    expect(pin.digest).toBe(durable.effectPlan.targetIndexFile.digest)
    expect(pin.byteLength).toBe(durable.effectPlan.targetIndexFile.byteLength)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    await expect(run('git', ['cat-file', '-e', objectId], { cwd: root, windowsHide: true })).resolves.toBeDefined()
  }, 60_000)

  it('never trusts a durable scratch path outside the operation-owned temporary range', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '6', 11)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
      }
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated crash before scratch recovery')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash before scratch recovery')
    persistence.restore()
    if (durable?.effectPlan === undefined) throw new Error('test did not retain an effect plan')
    roots.push(durable.effectPlan.scratch.path)
    const unrelated = await mkdtemp(join(tmpdir(), 'saki-unrelated-temporary-'))
    roots.push(unrelated)
    const marker = await readFile(join(durable.effectPlan.scratch.path, 'owner'))
    await writeFile(join(unrelated, 'owner'), marker)
    await persistence.original({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        scratch: { ...durable.effectPlan.scratch, path: unrelated },
      },
    })

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', snapshot: { state: 'publishing' } })
    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none' })
    await expect(readFile(join(unrelated, 'owner'))).resolves.toEqual(marker)
  }, 45_000)

  it('resumes a durable not-started index publication through its exact owned pin hard link', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '7', 12)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
      }
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated crash after prepublication index fill')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated crash after prepublication index fill')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test did not retain an index plan')
    const operationSchema = sakiHostExecutionDomainSpec.tables.operations.valueSchema
    const firstChange = durable.effectPlan.changes[0]
    if (firstChange === undefined) throw new Error('test index plan retained no changes')
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        changes: [{ ...firstChange, path: `${firstChange.path}-mismatch` }],
      },
    }).success).toBe(false)
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        result: { ...durable.effectPlan.result, changes: [] },
      },
    }).success).toBe(false)
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        pin: { ...durable.effectPlan.pin, path: join(root, 'tracked.txt') },
      },
    }).success).toBe(false)
    expect(operationSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        pin: { ...durable.effectPlan.pin, byteLength: durable.effectPlan.pin.byteLength + 1 },
      },
    }).success).toBe(false)
    const lockPath = join(root, '.git', 'index.lock')
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await link(durable.effectPlan.pin.path, lockPath)
    const pin = await stat(durable.effectPlan.pin.path, { bigint: true })
    const lock = await stat(lockPath, { bigint: true })
    expect({ device: lock.dev.toString(), inode: lock.ino.toString() }).toEqual({
      device: pin.dev.toString(),
      inode: pin.ino.toString(),
    })

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'publishing',
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
    let succeededRecord: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'succeeded') succeededRecord = record
    })
    const resumed = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    persistence.restore()
    expect(resumed).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    if (succeededRecord?.effectPlan?.kind !== 'index') throw new Error('test retained no succeeded index plan')
    const parsedSucceededRecord = operationSchema.safeParse(succeededRecord)
    expect(
      parsedSucceededRecord.success,
      parsedSucceededRecord.success ? undefined : JSON.stringify(parsedSucceededRecord.error.issues),
    ).toBe(true)
    const { effectPlan: _effectPlan, ...missingPlan } = succeededRecord
    expect(operationSchema.safeParse(missingPlan).success).toBe(false)
    expect(operationSchema.safeParse({
      ...succeededRecord,
      effectPlan: { ...succeededRecord.effectPlan, publication: 'attempting' },
    }).success).toBe(false)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 60_000)

  it('recovers an acknowledged-lost index publication from exact target evidence', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '7', 12)
    const persistence = operationPersistence(execution)
    let pinPath: string | undefined
    let scratchPath: string | undefined
    persistence.replace(async (record) => {
      if (record.effectPlan?.kind === 'index') {
        pinPath = record.effectPlan.pin.path
        scratchPath = record.effectPlan.scratch.path
      }
      if (record.snapshot.state === 'succeeded') {
        await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
        if (pinPath === undefined || scratchPath === undefined) throw new Error('test retained no cleanup resources')
        await expect(stat(pinPath)).resolves.toBeDefined()
        await expect(stat(scratchPath)).resolves.toBeDefined()
        await persistence.original(record)
        throw new Error('simulated durability acknowledgement loss')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated durability acknowledgement loss')
    persistence.restore()
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    if (pinPath === undefined || scratchPath === undefined) throw new Error('test retained no cleanup resources')
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()

    const recovered = await execution.inspectOperation(prepared.preparation.operation, signal)
    expect(recovered).toMatchObject({
      state: 'succeeded',
      result: { type: 'stage-files', changes: [{ path: 'tracked.txt' }] },
    })
    expect(liveOperationCount(execution)).toBe(0)
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toEqual(recovered)
  }, 45_000)

  it('does not strand an applied Stage when nonblocking pin cleanup cannot prove ownership', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '7', 12)
    const persistence = operationPersistence(execution)
    let pinPath: string | undefined
    let pinBytes: Buffer | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'succeeded' && record.effectPlan?.kind === 'index') {
        pinPath = record.effectPlan.pin.path
        pinBytes = await readFile(pinPath)
        await writeFile(pinPath, Buffer.from([0]), { flag: 'a' })
      }
      await persistence.original(record)
    })

    expect(await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    persistence.restore()
    if (pinPath === undefined || pinBytes === undefined) throw new Error('test retained no index pin')
    expect((await stat(pinPath)).size).toBe(pinBytes.byteLength + 1)
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
    })
    expect((await stat(pinPath)).size).toBe(pinBytes.byteLength + 1)

    await writeFile(pinPath, pinBytes)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
    })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('requires reconciliation when an attempted publication returns to expected evidence without its witness', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedStage(execution, root, signal, '8', 13)
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        durable = record
        throw new Error('simulated process loss after attempting evidence')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated process loss')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'index') throw new Error('test retained no attempted index plan')
    const lockPath = join(root, '.git', 'index.lock')
    await link(durable.effectPlan.pin.path, lockPath)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'reconciliation-required',
      reason: 'evidence-conflict',
    })
    expect(liveOperationCount(execution)).toBe(0)
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 45_000)

  it('rejects a Commit when only the worktree drifts after preparation', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'c',
      23,
      'staged commit content\n',
      'worktree precondition\n',
    )
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const stagedTree = await gitText(root, 'write-tree')
    await writeFile(join(root, 'tracked.txt'), 'worktree-only drift\n')

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: { state: 'failed', failure: { reason: 'observation-stale' }, effect: 'none' },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'write-tree')).toBe(stagedTree)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 45_000)

  it('publishes one deterministic hook-free Commit through update-ref CAS', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'committed\n')
    await git(root, 'add', '--', 'tracked.txt')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') return
    const request: CommitHostOperationRequest = {
      type: 'commit',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: '9'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      message: 'deterministic subject\n\nexact body\n',
    }
    const admission: HostOperationAdmissionSource = () => Promise.resolve({
      kind: 'accepted',
      admissionRevision: 14,
    })
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const persistence = operationPersistence(execution)
    let succeededRecord: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'succeeded') succeededRecord = record
    })

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    persistence.restore()

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'commit',
          parent: { kind: 'commit', objectId: parent },
          target: { kind: 'symbolic-ref', ref: 'refs/heads/main' },
          author: { name: 'Saki Test', email: 'saki@example.invalid', source: 'git-config' },
          committer: { name: 'Saki Test', email: 'saki@example.invalid', source: 'git-config' },
        },
      },
    })
    if (!started.ok || started.snapshot.state !== 'succeeded'
      || started.snapshot.result.type !== 'commit') return
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(started.snapshot.result.commitId)
    expect(await gitText(root, 'show', '-s', '--format=%B', 'HEAD')).toBe('deterministic subject\n\nexact body')
    expect(await gitText(root, 'status', '--porcelain=v1')).toBe('')
    expect(started.snapshot.result.treeId).toBe(inspected.observation.index.treeId)
    if (succeededRecord?.effectPlan?.kind !== 'commit') throw new Error('test retained no Commit plan')
    const operationSchema = sakiHostExecutionDomainSpec.tables.operations.valueSchema
    const parsedSucceededRecord = operationSchema.safeParse(succeededRecord)
    expect(
      parsedSucceededRecord.success,
      parsedSucceededRecord.success ? undefined : JSON.stringify(parsedSucceededRecord.error.issues),
    ).toBe(true)
    expect(operationSchema.safeParse({
      ...succeededRecord,
      effectPlan: { ...succeededRecord.effectPlan, targetRef: 'refs/heads/other' },
    }).success).toBe(false)
    expect(operationSchema.safeParse({
      ...succeededRecord,
      effectPlan: {
        ...succeededRecord.effectPlan,
        result: { ...succeededRecord.effectPlan.result, commitId: '0'.repeat(40) },
      },
    }).success).toBe(false)
    if (succeededRecord.request.type !== 'commit'
      || succeededRecord.request.expected.head.kind !== 'commit'
      || succeededRecord.snapshot.state !== 'succeeded'
      || succeededRecord.snapshot.result.type !== 'commit') {
      throw new Error('test retained no attached succeeded Commit')
    }
    const longRef = `refs/heads/${'a/'.repeat(600)}branch`
    expect(longRef.length).toBeGreaterThan(1_024)
    expect(longRef.length).toBeLessThanOrEqual(MAX_GIT_REF_CHARS)
    const longRequest = {
      ...succeededRecord.request,
      expected: {
        ...succeededRecord.request.expected,
        head: { ...succeededRecord.request.expected.head, symbolicRef: longRef },
      },
    }
    const requestFingerprint = localHostOperationRequestFingerprint(longRequest)
    const result = {
      ...succeededRecord.effectPlan.result,
      target: { kind: 'symbolic-ref' as const, ref: longRef },
    }
    const operationId = succeededRecord.snapshot.operation.id
    const marker = (kind: 'scratch' | 'index-lock'): Buffer => Buffer.from(
      `saki-host-operation-${kind}/v1\0${operationId}\0${requestFingerprint.digest}\0`,
      'utf8',
    )
    const scratchMarker = marker('scratch')
    const indexMarker = marker('index-lock')
    expect(operationSchema.safeParse({
      ...succeededRecord,
      request: longRequest,
      snapshot: { ...succeededRecord.snapshot, requestFingerprint, result },
      effectPlan: {
        ...succeededRecord.effectPlan,
        targetRef: longRef,
        result,
        scratch: {
          ...succeededRecord.effectPlan.scratch,
          markerDigest: createHash('sha256').update(scratchMarker).digest('hex'),
        },
        pin: {
          ...succeededRecord.effectPlan.pin,
          digest: createHash('sha256').update(indexMarker).digest('hex'),
          byteLength: indexMarker.byteLength,
        },
      },
    }).success).toBe(true)
  }, 45_000)

  it('creates the frozen attached branch for an unborn Commit', async () => {
    const root = await unbornRepository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared, inspected } = await preparedCommit(
      execution,
      root,
      signal,
      'a',
      15,
      'first tracked contents\n',
      'initial structured commit\n',
    )

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'commit',
          treeId: inspected.observation.index.kind === 'tree'
            ? inspected.observation.index.treeId
            : undefined,
          parent: { kind: 'none' },
          target: { kind: 'symbolic-ref', ref: 'refs/heads/main' },
        },
      },
    })
    if (!started.ok || started.snapshot.state !== 'succeeded'
      || started.snapshot.result.type !== 'commit') return
    expect(await gitText(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(await gitText(root, 'rev-parse', 'refs/heads/main')).toBe(started.snapshot.result.commitId)
  }, 45_000)

  it('removes a Commit scratch when the first effect-plan persistence fails', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'b',
      16,
      'discarded commit contents\n',
      'discarded commit candidate\n',
    )
    const persistence = operationPersistence(execution)
    let scratchPath: string | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        scratchPath = record.effectPlan.scratch.path
        throw new Error('simulated first Commit plan persistence failure')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated first Commit plan persistence failure')
    persistence.restore()
    expect(scratchPath).toBeDefined()
    if (scratchPath === undefined) return
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('persists a complete Commit pin before creating the blocking index lock', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'b',
      16,
      'pinned commit contents\n',
      'durable pinned commit candidate\n',
    )
    const persistence = operationPersistence(execution)
    let pinPath: string | undefined
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
        && record.effectPlan.publication === 'not-started') {
        durable = record
        const pin = (record.effectPlan as unknown as {
          readonly pin: {
            readonly path: string
            readonly digest: string
            readonly byteLength: number
            readonly identity: { readonly device: string; readonly inode: string }
            readonly mode: number
          }
        }).pin
        pinPath = pin.path
        const bytes = await readFile(pin.path)
        const info = await stat(pin.path, { bigint: true })
        expect(bytes.byteLength).toBe(pin.byteLength)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.digest)
        expect(Number(info.mode & 0o777n)).toBe(pin.mode)
        expect({ device: info.dev.toString(), inode: info.ino.toString() }).toEqual(pin.identity)
        await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
        throw new Error('simulated first Commit plan persistence failure after pin inspection')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated first Commit plan persistence failure after pin inspection')
    persistence.restore()
    expect(pinPath).toBeDefined()
    if (pinPath !== undefined) await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (durable?.effectPlan?.kind !== 'commit') throw new Error('test retained no Commit plan')
    expect(sakiHostExecutionDomainSpec.tables.operations.valueSchema.safeParse({
      ...durable,
      effectPlan: {
        ...durable.effectPlan,
        pin: { ...durable.effectPlan.pin, byteLength: durable.effectPlan.pin.byteLength + 1 },
      },
    }).success).toBe(false)
  }, 60_000)

  it('keeps Commit terminal cleanup retryable after a committed persistence acknowledgement loss', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'b',
      16,
      'terminal Commit contents\n',
      'terminal Commit acknowledgement\n',
    )
    const persistence = operationPersistence(execution)
    let pinPath: string | undefined
    let scratchPath: string | undefined
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'succeeded' && record.effectPlan?.kind === 'commit') {
        pinPath = record.effectPlan.pin.path
        scratchPath = record.effectPlan.scratch.path
        await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(pinPath)).resolves.toBeDefined()
        await expect(stat(scratchPath)).resolves.toBeDefined()
        await persistence.original(record)
        throw new Error('simulated committed Commit acknowledgement loss')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated committed Commit acknowledgement loss')
    persistence.restore()
    if (pinPath === undefined || scratchPath === undefined) throw new Error('test retained no cleanup resources')
    await expect(stat(pinPath)).resolves.toBeDefined()
    await expect(stat(scratchPath)).resolves.toBeDefined()

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
      result: { type: 'commit' },
    })
    await expect(stat(join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(pinPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('publishes to the frozen branch when an external checkout races after final validation', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    await git(root, 'branch', 'other')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'b',
      16,
      'race-safe contents\n',
      'frozen target commit\n',
    )
    const runner = mutationRunner(execution)
    let raced = false
    runner.replace(async (...args) => {
      const [, command] = args
      if (!raced && command[0] === 'update-ref') {
        raced = true
        await git(root, 'symbolic-ref', 'HEAD', 'refs/heads/other')
      }
      return await runner.original(...args)
    })

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    runner.restore()

    expect(raced).toBe(true)
    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: { type: 'commit', target: { kind: 'symbolic-ref', ref: 'refs/heads/main' } },
      },
    })
    if (!started.ok || started.snapshot.state !== 'succeeded'
      || started.snapshot.result.type !== 'commit') return
    expect(await gitText(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/other')
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'rev-parse', 'refs/heads/main')).toBe(started.snapshot.result.commitId)
  }, 60_000)

  it('recovers an acknowledged-lost attached Commit after its target branch advances', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution,
      root,
      signal,
      'c',
      17,
      'recoverable contents\n',
      'recoverable attached commit\n',
    )
    const persistence = operationPersistence(execution)
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'succeeded') {
        throw new Error('simulated attached Commit acknowledgement loss')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated attached Commit acknowledgement loss')
    persistence.restore()
    const publishedCommit = await gitText(root, 'rev-parse', 'refs/heads/main')
    await git(root, 'commit', '--allow-empty', '-m', 'later attached commit')
    expect(await gitText(root, 'rev-parse', 'refs/heads/main')).not.toBe(publishedCommit)

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
      result: {
        type: 'commit',
        commitId: publishedCommit,
        target: { kind: 'symbolic-ref', ref: 'refs/heads/main' },
      },
    })
  }, 60_000)

  it('rejects a detached Commit during Host preparation without changing HEAD', async () => {
    const root = await repository()
    await git(root, 'checkout', '--detach')
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'detached\n')
    await git(root, 'add', '--', 'tracked.txt')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') return
    expect(inspected.observation).toMatchObject({
      branch: { kind: 'detached' },
      structuredMutation: { available: true, blockers: [] },
    })
    const request: CommitHostOperationRequest = {
      type: 'commit',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: 'a'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      message: 'detached commit\n',
    }
    const admission = acceptedAdmission(15)
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared).toEqual({ ok: false, reason: 'unavailable' })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    await expect(run('git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: root,
      windowsHide: true,
    })).rejects.toMatchObject({ code: 1 })
  }, 45_000)

  it('fails a replayed historical detached Commit before effect', async () => {
    const root = await repository()
    await git(root, 'checkout', '--detach')
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await writeFile(join(root, 'tracked.txt'), 'historical detached\n')
    await git(root, 'add', '--', 'tracked.txt')
    const inspected = await execution.inspectProject({ binding }, signal)
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true)
    if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
      || inspected.observation.index.kind !== 'tree') return
    const request: CommitHostOperationRequest = {
      type: 'commit',
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 2,
        payloadDigest: 'b'.repeat(64),
      },
      expected: {
        binding,
        status: inspected.observation.fingerprint,
        head: inspected.observation.head,
        index: inspected.observation.index,
        worktree: inspected.observation.worktree,
        preEffectBaseline: inspected.preEffectBaseline,
      },
      message: 'historical detached commit\n',
    }
    const requestFingerprint = localHostOperationRequestFingerprint(request)
    const preparedAt = Date.now()
    const operation = {
      id: 'host-operation-11111111-1111-4111-8111-111111111111' as const,
      hostId: HOST_ID,
      type: 'commit' as const,
    }
    const record = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      schemaVersion: 1,
      request,
      preparationRevision: 0,
      snapshot: {
        operation,
        revision: 0,
        source: request.source,
        requestFingerprint,
        bindingId: binding.id,
        bindingRevision: binding.revision,
        preparedAt,
        updatedAt: preparedAt,
        state: 'prepared',
        admission: { kind: 'not-accepted' },
      },
    })
    const operationTable = (execution as unknown as {
      operationTable: { put: (id: typeof operation.id, value: LocalHostOperationRecord) => Promise<void> }
    }).operationTable
    await operationTable.put(operation.id, record)
    const admission = acceptedAdmission(15)
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  }, 45_000)

  it('fails a historical durable detached not-started Commit without resuming its effect', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'b', 16, 'historical candidate\n', 'historical detached commit\n',
    )
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'not-started') {
        durable = record
        throw new Error('captured historical Commit plan')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('captured historical Commit plan')
    persistence.restore()
    if (durable === undefined) throw new Error('test retained no historical Commit plan')
    const historical = await asHistoricalDetached(durable)
    await persistence.original(historical)
    await git(root, 'checkout', '--detach')

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'failed',
      failure: { reason: 'unsupported-state' },
      effect: 'none',
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  }, 60_000)

  it('read-only recovers a historical detached Commit with applied attempted evidence', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'b', 16, 'historical applied candidate\n', 'historical applied commit\n',
    )
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        durable = record
        throw new Error('captured historical attempted Commit')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('captured historical attempted Commit')
    persistence.restore()
    if (durable === undefined) throw new Error('test retained no attempted Commit plan')
    const historical = await asHistoricalDetached(durable)
    if (historical.effectPlan?.kind !== 'commit') throw new Error('test retained no detached Commit plan')
    await persistence.original(historical)
    await git(root, 'checkout', '--detach')
    await git(root, 'update-ref', 'HEAD', historical.effectPlan.result.commitId, parent)

    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'succeeded',
      result: {
        type: 'commit',
        commitId: historical.effectPlan.result.commitId,
        target: { kind: 'detached-head' },
      },
    })
  }, 60_000)

  it('cancels a durable not-started Commit without publishing its candidate', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'c', 17, 'cancel candidate\n', 'cancel durable commit\n',
    )
    const persistence = operationPersistence(execution)
    persistence.replace(async (record) => {
      if (record.snapshot.state === 'publishing' && record.effectPlan?.publication === 'attempting') {
        throw new Error('simulated Commit loss before attempting evidence became durable')
      }
      await persistence.original(record)
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated Commit loss before attempting evidence became durable')
    persistence.restore()

    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'publishing',
    })
    expect(await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).toMatchObject({ state: 'canceled', effect: 'none', reason: 'source-canceled' })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
  }, 60_000)

  it('requires reconciliation when a Commit attempt has no publication witness', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'd', 18, 'reconcile candidate\n', 'reconcile durable commit\n',
    )
    const persistence = operationPersistence(execution)
    let durable: LocalHostOperationRecord | undefined
    persistence.replace(async (record) => {
      await persistence.original(record)
      if (record.snapshot.state === 'publishing' && record.effectPlan?.kind === 'commit'
        && record.effectPlan.publication === 'attempting') {
        durable = record
        throw new Error('simulated Commit loss after attempting evidence became durable')
      }
    })

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).rejects.toThrow('simulated Commit loss after attempting evidence became durable')
    persistence.restore()
    if (durable?.effectPlan?.kind !== 'commit') throw new Error('test retained no attempted Commit plan')
    const lockPath = join(root, '.git', 'index.lock')
    await link(durable.effectPlan.pin.path, lockPath)

    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await execution.inspectOperation(prepared.preparation.operation, signal)).toMatchObject({
      state: 'reconciliation-required',
      reason: 'evidence-conflict',
    })
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.pin.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(durable.effectPlan.scratch.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('fails a Commit before effect when repository-local identity is unavailable', async () => {
    const root = await repository()
    const parent = await gitText(root, 'rev-parse', 'HEAD')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'e', 19, 'identity candidate\n', 'identity unavailable commit\n',
    )
    await git(root, 'config', '--unset', 'user.name')
    await git(root, 'config', '--unset', 'user.email')

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started).toMatchObject({
      ok: true,
      snapshot: {
        state: 'failed',
        failure: { reason: 'unsupported-state' },
        effect: 'none',
      },
    })
    expect(await gitText(root, 'rev-parse', 'HEAD')).toBe(parent)
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 60_000)

  it('retries a temporary Commit prepublication failure without consuming the operation', async () => {
    const root = await repository()
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, 'f', 20, 'retry candidate\n', 'retry durable commit\n',
    )
    const runner = mutationRunner(execution)
    let failed = false
    runner.replace(async (...args) => {
      const [, command, , environment] = args
      if (!failed && command[0] === 'write-tree' && environment.objectDirectory === undefined) {
        failed = true
        throw new GitCommandError('spawn-failure')
      }
      return await runner.original(...args)
    })

    const first = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    runner.restore()

    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      snapshot: { state: 'publishing' },
    })
    const second = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    expect(second).toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
  }, 90_000)

  it('does not execute configured or ambient Git programs while committing', async () => {
    const root = await repository()
    const sentinelRoot = await mkdtemp(join(tmpdir(), 'saki-commit-sentinel-'))
    roots.push(sentinelRoot)
    const marker = join(sentinelRoot, 'executed')
    const script = join(sentinelRoot, 'sentinel.mjs')
    await writeFile(script, [
      "import { appendFileSync } from 'node:fs'",
      'appendFileSync(process.argv[2], `${process.argv[3]}\\n`)',
      '',
    ].join('\n'))
    const command = (label: string): string => [process.execPath, script, marker, label]
      .map(value => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`)
      .join(' ')
    for (const [key, value] of [
      ['core.hooksPath', sentinelRoot],
      ['commit.gpgSign', 'true'],
      ['gpg.program', command('gpg')],
      ['core.editor', command('editor')],
      ['core.pager', command('pager')],
      ['core.askPass', command('askpass')],
    ] as const) await git(root, 'config', key, value)
    const hook = join(sentinelRoot, 'reference-transaction')
    await writeFile(hook, `#!/bin/sh\n${command('reference-transaction')}\n`)
    await chmod(hook, 0o755)
    vi.stubEnv('GIT_AUTHOR_NAME', 'ambient author')
    vi.stubEnv('GIT_COMMITTER_NAME', 'ambient committer')
    vi.stubEnv('GIT_CONFIG_COUNT', '2')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hooksPath')
    vi.stubEnv('GIT_CONFIG_VALUE_0', sentinelRoot)
    vi.stubEnv('GIT_CONFIG_KEY_1', 'commit.gpgSign')
    vi.stubEnv('GIT_CONFIG_VALUE_1', 'true')
    const execution = await provider(root)
    const signal = new AbortController().signal
    const { prepared } = await preparedCommit(
      execution, root, signal, '0', 21, 'hook-free candidate\n', 'hook-free durable commit\n',
    )

    const started = await execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )

    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      snapshot: {
        state: 'succeeded',
        result: {
          type: 'commit',
          author: { name: 'Saki Test', email: 'saki@example.invalid' },
          committer: { name: 'Saki Test', email: 'saki@example.invalid' },
        },
      },
    })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
})

async function asHistoricalDetached(record: LocalHostOperationRecord): Promise<LocalHostOperationRecord> {
  if (record.effectPlan?.kind !== 'commit' || record.request.expected.head.kind !== 'commit') {
    throw new Error('test retained no historical Commit plan')
  }
  const detachedRequest = {
    ...record.request,
    expected: {
      ...record.request.expected,
      head: { kind: 'commit' as const, objectId: record.request.expected.head.objectId },
    },
  }
  const requestFingerprint = localHostOperationRequestFingerprint(detachedRequest)
  const scratchMarker = Buffer.from(
    `saki-host-operation-scratch/v1\0${record.snapshot.operation.id}\0${requestFingerprint.digest}\0`,
    'utf8',
  )
  const indexMarker = Buffer.from(
    `saki-host-operation-index-lock/v1\0${record.snapshot.operation.id}\0${requestFingerprint.digest}\0`,
    'utf8',
  )
  await writeFile(join(record.effectPlan.scratch.path, 'owner'), scratchMarker)
  await writeFile(record.effectPlan.pin.path, indexMarker)
  const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
  return sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    ...record,
    request: detachedRequest,
    snapshot: { ...record.snapshot, requestFingerprint },
    effectPlan: {
      ...record.effectPlan,
      scratch: { ...record.effectPlan.scratch, markerDigest: digest(scratchMarker) },
      targetRef: 'HEAD',
      pin: {
        ...record.effectPlan.pin,
        digest: digest(indexMarker),
        byteLength: indexMarker.byteLength,
      },
      result: { ...record.effectPlan.result, target: { kind: 'detached-head' } },
    },
  })
}

async function provider(root: string): Promise<LocalSakiHostExecution> {
  const ctx = new Context()
  contexts.push(ctx)
  const storageRoot = await mkdtemp(join(tmpdir(), 'saki-host-operation-storage-'))
  roots.push(storageRoot)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(storageRoot, 'saki.db'), journalMode: 'delete' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('workspaceRegistry', { list: () => [{ id: WORKSPACE_ID, path: root }] })
  await ctx.plugin(LocalSakiHostExecution, CONFIG)
  return ctx.sakiHostExecution as LocalSakiHostExecution
}

async function activeBinding(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
): Promise<ActiveHostProjectBinding> {
  const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
  expect(selected.ok, JSON.stringify(selected)).toBe(true)
  if (!selected.ok) throw new Error('test repository was not selectable')
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

async function preparedStage(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
  payloadDigit: string,
  admissionRevision: number,
  selectedPath = 'tracked.txt',
) {
  const binding = await activeBinding(execution, root, signal)
  await writeFile(join(root, selectedPath), 'changed\n')
  const inspected = await execution.inspectProject({ binding }, signal)
  if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
    || inspected.observation.index.kind !== 'tree') {
    throw new Error(`test repository was not mutable: ${JSON.stringify(inspected)}`)
  }
  const change = inspected.observation.changes.find(candidate => candidate.path === selectedPath)
  if (change === undefined) throw new Error('test repository had no changed path')
  const request: StageFilesHostOperationRequest = {
    type: 'stage-files',
    source: {
      kind: 'control-intent',
      intentId: INTENT_ID,
      intentRevision: 2,
      payloadDigest: payloadDigit.repeat(64),
    },
    expected: {
      binding,
      status: inspected.observation.fingerprint,
      head: inspected.observation.head,
      index: inspected.observation.index,
      worktree: inspected.observation.worktree,
      preEffectBaseline: inspected.preEffectBaseline,
    },
    changes: [{ id: change.id, fingerprint: change.fingerprint }],
  }
  const admission: HostOperationAdmissionSource = () => Promise.resolve({ kind: 'accepted', admissionRevision })
  const prepared = await execution.prepareOperation(request, admission, signal)
  if (!prepared.ok) throw new Error(`test operation was not prepared: ${prepared.reason}`)
  return { prepared, change }
}

function acceptedAdmission(admissionRevision: number): HostOperationAdmissionSource {
  return () => Promise.resolve({ kind: 'accepted', admissionRevision })
}

async function preparedCommit(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
  payloadDigit: string,
  admissionRevision: number,
  contents: string,
  message: string,
) {
  const binding = await activeBinding(execution, root, signal)
  await writeFile(join(root, 'tracked.txt'), contents)
  await git(root, 'add', '--', 'tracked.txt')
  const inspected = await execution.inspectProject({ binding }, signal)
  if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
    || inspected.observation.index.kind !== 'tree') {
    throw new Error(`test repository was not committable: ${JSON.stringify(inspected)}`)
  }
  const request: CommitHostOperationRequest = {
    type: 'commit',
    source: {
      kind: 'control-intent',
      intentId: INTENT_ID,
      intentRevision: 2,
      payloadDigest: payloadDigit.repeat(64),
    },
    expected: {
      binding,
      status: inspected.observation.fingerprint,
      head: inspected.observation.head,
      index: inspected.observation.index,
      worktree: inspected.observation.worktree,
      preEffectBaseline: inspected.preEffectBaseline,
    },
    message,
  }
  const admission: HostOperationAdmissionSource = () => Promise.resolve({ kind: 'accepted', admissionRevision })
  const prepared = await execution.prepareOperation(request, admission, signal)
  if (!prepared.ok) throw new Error(`test Commit was not prepared: ${prepared.reason}`)
  return { prepared, inspected }
}

function operationPersistence(execution: LocalSakiHostExecution) {
  const target = execution as unknown as {
    persistOperation: (record: LocalHostOperationRecord) => Promise<void>
  }
  const original = target.persistOperation.bind(execution)
  return {
    original,
    replace(replacement: (record: LocalHostOperationRecord) => Promise<void>) {
      target.persistOperation = replacement
    },
    restore() {
      target.persistOperation = original
    },
  }
}

function liveOperationCount(execution: LocalSakiHostExecution): number {
  return (execution as unknown as { liveOperations: ReadonlyMap<unknown, unknown> }).liveOperations.size
}

function mutationRunner(execution: LocalSakiHostExecution) {
  const target = execution as unknown as { git: GitRunner }
  const original = target.git.runMutation.bind(target.git)
  return {
    original,
    replace(replacement: GitRunner['runMutation']) {
      target.git.runMutation = replacement.bind(target.git)
    },
    restore() {
      target.git.runMutation = original
    },
  }
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-host-operation-repository-'))
  roots.push(root)
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Saki Test')
  await git(root, 'config', 'user.email', 'saki@example.invalid')
  await writeFile(join(root, 'tracked.txt'), 'base\n')
  await git(root, 'add', '--', 'tracked.txt')
  await git(root, 'commit', '-m', 'base')
  return root
}

async function unbornRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-host-operation-unborn-'))
  roots.push(root)
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Saki Test')
  await git(root, 'config', 'user.email', 'saki@example.invalid')
  return root
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', args, { cwd, windowsHide: true })
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
  return stdout.trim()
}
