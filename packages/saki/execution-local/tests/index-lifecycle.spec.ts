import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { HostOperationAcceptance } from '@breakfastdapaidang/saki-execution'
import type {
  ActiveHostProjectBinding,
  HostOperationAdmissionSource,
  HostOperationReference,
  SakiControlIntentId,
  SakiHostId,
  SakiResourceBindingId,
  StageFilesHostOperationRequest,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalSakiHostExecution, { type Config } from '../src/index.ts'
import { provideInertLocalAgentRunDependencies } from './storage.ts'

const run = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
const BINDING_ID = 'binding-11111111-1111-4111-8111-111111111111' as SakiResourceBindingId
const WORKSPACE_ID = WorkspaceId('workspace-index-lifecycle')
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
const BOUNDED_ADMISSIONS: readonly (readonly [string, HostOperationAdmissionSource])[] = [
  ['denied', async () => ({ kind: 'denied', reason: 'source-canceled' })],
  ['unavailable', async () => ({ kind: 'unavailable' })],
]

class ForeignHostOperationAcceptance extends HostOperationAcceptance {
  static create(): ForeignHostOperationAcceptance {
    return new ForeignHostOperationAcceptance()
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('LocalSakiHostExecution lifecycle interface', () => {
  it('rejects every asynchronous entry after provider disposal', async () => {
    const root = await repository()
    const { execution, fiber } = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const request = await stageRequest(execution, root, binding, signal, '1')
    const prepared = await execution.prepareOperation(request, accepted(1), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    await fiber.dispose()
    const disposed = 'Saki Local Host Execution disposed'

    await expect(execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal))
      .rejects.toThrow(disposed)
    await expect(execution.inspectProject({ binding }, signal)).rejects.toThrow(disposed)
    const change = request.changes[0]
    if (change === undefined) throw new Error('stage request has no change')
    await expect(execution.readDiff(binding, {
      expectedStatus: request.expected.status,
      changeId: change.id,
      layer: 'unstaged',
    }, signal)).rejects.toThrow(disposed)
    await expect(execution.prepareOperation(request, accepted(1), signal)).rejects.toThrow(disposed)
    await expect(execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal))
      .rejects.toThrow(disposed)
    await expect(execution.inspectOperation(prepared.preparation.operation, signal)).rejects.toThrow(disposed)
    await expect(execution.cancelOperation(prepared.preparation.operation, 'source-canceled', signal))
      .rejects.toThrow(disposed)
  }, 30_000)

  it.each(BOUNDED_ADMISSIONS)('returns bounded %s admission without changing Git', async (_name, admission) => {
    const root = await repository()
    const { execution } = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const request = await stageRequest(execution, root, binding, signal, _name === 'denied' ? '2' : '3')
    const prepared = await execution.prepareOperation(request, admission, signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const started = await execution.startOperation(prepared.preparation.operation, prepared.acceptance, signal)

    expect(started).toMatchObject({
      ok: false,
      reason: _name === 'denied' ? 'source-canceled' : 'unavailable',
      snapshot: { state: 'prepared', admission: { kind: 'not-accepted' } },
    })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
  }, 30_000)

  it('rejects a changed admission revision and unknown operation references', async () => {
    const root = await repository()
    const { execution } = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const request = await stageRequest(execution, root, binding, signal, '4')
    const first = await execution.prepareOperation(request, accepted(4), signal)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const interrupted = new AbortController()
    const removedListener = vi.fn()
    const remainingListener = vi.fn()
    const dispose = execution.onChanged((change) => {
      removedListener(change)
      if (change.operation.id === first.preparation.operation.id && change.revision === 1) {
        interrupted.abort(new Error('stop after durable admission'))
      }
    })
    execution.onChanged(remainingListener)
    await expect(execution.startOperation(
      first.preparation.operation,
      first.acceptance,
      interrupted.signal,
    )).rejects.toThrow('stop after durable admission')
    dispose()
    await expect(execution.inspectOperation(first.preparation.operation, signal))
      .resolves.toMatchObject({ state: 'accepted', admission: { kind: 'accepted', revision: 4 } })
    const replay = await execution.prepareOperation(request, accepted(5), signal)
    expect(replay.ok).toBe(true)
    if (!replay.ok) return
    await expect(execution.startOperation(replay.preparation.operation, replay.acceptance, signal))
      .resolves.toMatchObject({ ok: false, reason: 'not-current', snapshot: { state: 'accepted' } })

    const removedCalls = removedListener.mock.calls.length
    const remainingCalls = remainingListener.mock.calls.length
    const independentRequest = await stageRequest(execution, root, binding, signal, '6')
    await expect(execution.prepareOperation(independentRequest, accepted(6), signal))
      .resolves.toMatchObject({ ok: true, snapshot: { revision: 0 } })
    expect(removedListener).toHaveBeenCalledTimes(removedCalls)
    expect(remainingListener).toHaveBeenCalledTimes(remainingCalls + 1)

    const unknown = {
      ...first.preparation.operation,
      id: 'host-operation-99999999-9999-4999-8999-999999999999',
    } as HostOperationReference<'stage-files'>
    await expect(execution.inspectOperation(unknown, signal)).rejects.toThrow('unknown Saki Host Operation')
    await expect(execution.cancelOperation(unknown, 'source-canceled', signal))
      .rejects.toThrow('unknown Saki Host Operation')
  }, 30_000)

  it('contains one failing change listener and continues later listeners', async () => {
    const root = await repository()
    const { context, execution } = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const request = await stageRequest(execution, root, binding, signal, '5')
    const later = vi.fn()
    const warning = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    execution.onChanged(() => { throw new Error('listener secret') })
    execution.onChanged(later)

    await expect(execution.prepareOperation(request, accepted(5), signal)).resolves.toMatchObject({ ok: true })

    expect(later).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith('[saki-execution-local] Host Operation change listener failed')
    expect(JSON.stringify(warning.mock.calls)).not.toContain('listener secret')
  }, 30_000)

  it('rejects a foreign acceptance and replays terminal cancellation idempotently', async () => {
    const root = await repository()
    const { execution } = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const request = await stageRequest(execution, root, binding, signal, '9')
    const prepared = await execution.prepareOperation(request, accepted(9), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    await expect(execution.startOperation(
      prepared.preparation.operation,
      ForeignHostOperationAcceptance.create(),
      signal,
    )).resolves.toMatchObject({
      ok: false,
      reason: 'acceptance-mismatch',
      snapshot: { state: 'prepared', revision: 0 },
    })

    const canceled = await execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )
    expect(canceled).toMatchObject({ state: 'canceled', revision: 1, effect: 'none' })
    await expect(execution.cancelOperation(
      prepared.preparation.operation,
      'source-canceled',
      signal,
    )).resolves.toEqual(canceled)
    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toEqual({ ok: true, snapshot: canceled })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('')
  }, 30_000)

  it('fails loud when operation storage has not started', async () => {
    const context = new Context()
    contexts.push(context)
    const execution = new LocalSakiHostExecution(context, CONFIG)
    const reference = {
      id: 'host-operation-99999999-9999-4999-8999-999999999999',
      hostId: HOST_ID,
      type: 'stage-files',
    } as HostOperationReference<'stage-files'>

    await expect(execution.inspectOperation(reference, new AbortController().signal))
      .rejects.toThrow('Saki Local Host Operation storage is not started')
  })

  it.each([
    ['sha1', '7'],
    ['sha256', '8'],
  ] as const)('accounts for fixed update-index bytes at the exact %s path budget', async (objectFormat, digit) => {
    const root = await repository(objectFormat)
    const { execution } = await provider(root, { inventoryMaxPathBytes: Buffer.byteLength('tracked.txt') })
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    const request = await stageRequest(execution, root, binding, signal, digit)
    const prepared = await execution.prepareOperation(request, accepted(1), signal)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    await expect(execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )).resolves.toMatchObject({ ok: true, snapshot: { state: 'succeeded' } })
    expect(await gitText(root, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
  }, 60_000)

  it('projects a disappeared bound repository as a bounded inspection failure', async () => {
    const root = await repository()
    const { execution } = await provider(root)
    const signal = new AbortController().signal
    const binding = await activeBinding(execution, root, signal)
    await rm(root, { recursive: true, force: true })

    await expect(execution.inspectProject({ binding }, signal))
      .resolves.toEqual({ ok: false, reason: 'missing' })
  }, 30_000)
})

function accepted(revision: number): HostOperationAdmissionSource {
  return async () => ({ kind: 'accepted', admissionRevision: revision })
}

async function provider(root: string, config: Partial<Config> = {}): Promise<{
  readonly context: Context
  readonly execution: LocalSakiHostExecution
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const context = new Context()
  contexts.push(context)
  const storageRoot = await mkdtemp(join(tmpdir(), 'saki-index-lifecycle-storage-'))
  roots.push(storageRoot)
  await context.plugin(Storage)
  await context.plugin(StorageSqlite, { path: join(storageRoot, 'saki.db'), journalMode: 'delete' })
  await context.plugin(StorageDomain, { backend: 'sqlite' })
  provideInertLocalAgentRunDependencies(context)
  await context.plugin(LocalFileSystem, { cwd: process.cwd() })
  await context.plugin(LocalSubprocessRuntime)
  context.provide('workspaceRegistry', { list: () => [{ id: WORKSPACE_ID, path: root }] })
  const fiber = await context.plugin(LocalSakiHostExecution, { ...CONFIG, ...config })
  return { context, execution: context.sakiHostExecution as LocalSakiHostExecution, fiber }
}

async function activeBinding(
  execution: LocalSakiHostExecution,
  root: string,
  signal: AbortSignal,
): Promise<ActiveHostProjectBinding> {
  const selected = await execution.inspectProjectSelection({ hostId: HOST_ID, directoryLocator: root }, signal)
  if (!selected.ok) throw new Error(`test repository was not selectable: ${selected.reason}`)
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

async function stageRequest(
  execution: LocalSakiHostExecution,
  root: string,
  binding: ActiveHostProjectBinding,
  signal: AbortSignal,
  payloadDigit: string,
): Promise<StageFilesHostOperationRequest> {
  await writeFile(join(root, 'tracked.txt'), 'changed\n')
  const inspected = await execution.inspectProject({ binding }, signal)
  if (!inspected.ok || inspected.preEffectBaseline.kind !== 'complete'
    || inspected.observation.index.kind !== 'tree') throw new Error('test repository was not mutable')
  const change = inspected.observation.changes[0]
  if (change === undefined) throw new Error('test repository had no change')
  return {
    type: 'stage-files',
    source: {
      kind: 'control-intent',
      intentId: `intent-${payloadDigit.repeat(8)}-${payloadDigit.repeat(4)}-4${payloadDigit.repeat(3)}-8${payloadDigit.repeat(3)}-${payloadDigit.repeat(12)}` as SakiControlIntentId,
      intentRevision: 1,
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
}

async function repository(objectFormat: 'sha1' | 'sha256' = 'sha1'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-index-lifecycle-repository-'))
  roots.push(root)
  await git(root, 'init', '-b', 'main', ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : []))
  await git(root, 'config', 'user.name', 'Saki Test')
  await git(root, 'config', 'user.email', 'saki@example.invalid')
  await writeFile(join(root, 'tracked.txt'), 'base\n')
  await git(root, 'add', '--', 'tracked.txt')
  await git(root, 'commit', '-m', 'base')
  return root
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', args, { cwd, windowsHide: true })
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd, windowsHide: true })).stdout.trim()
}
