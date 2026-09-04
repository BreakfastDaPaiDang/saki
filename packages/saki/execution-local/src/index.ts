/** Local Host provider for Saki inspection and structured Git operations. @module @breakfastdapaidang/saki-execution-local */

import { constants as bufferConstants } from 'node:buffer'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  advanceLocalGitMutation,
  cancelPublishingOperation,
  cleanupTerminalGitMutation,
  recoverPublishingOperation,
} from './git-mutation.ts'
import { localGitMutationInternalsFor } from './git-mutation-internals.ts'
import {
  HostOperationAcceptance,
  MAX_INHERITED_BASELINE_ENTRIES,
  MAX_INVENTORY_ENTRIES,
  SakiHostExecution,
} from '@breakfastdapaidang/saki-execution'
import type {
  ActiveHostProjectBinding,
  GitCredentialHelperId,
  HostOperationAdmissionSource,
  HostOperationCancellationReason,
  HostOperationChange,
  HostOperationChangedDisposer,
  HostOperationKind,
  HostOperationReceipt,
  HostOperationReference,
  HostOperationRequest,
  HostOperationSnapshot,
  HostOperationStartResult,
  InspectInterventionOpeningRequest,
  InterventionOpeningEvidence,
  InspectProjectRequest,
  InspectProjectResult,
  InspectProjectCommitRequest,
  InspectProjectCommitResult,
  InspectProjectSelectionRequest,
  InspectProjectSelectionResult,
  ReadProjectDiffRequest,
  ReadProjectDiffResult,
  StartAgentRunHostOperationRequest,
} from '@breakfastdapaidang/saki-execution'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { readLocalProjectDiff } from './diff.ts'
import { gitInspectionEnvironment, GitRunner, runBoundedCommand } from './git-runner.ts'
import {
  BoundProjectResourceMismatchError,
  inspectLocalProjectSelection,
  inspectStableLocalProjectSelection,
} from './inspection.ts'
import { completeBoundProjectInspection, projectInspectionFailure } from './inspection-result.ts'
import { readLocalAdministrativeDirectoryIdentity } from './identity.ts'
import { buildProjectGitStatusObservation } from './status.ts'
import {
  hostOperationSnapshotCore,
  localHostOperationRequestFingerprint,
  MIN_OPERATION_MAX_INDEX_BYTES,
  sakiHostExecutionDomainSpec,
  type LocalHostAgentRunOperationRecord,
  type LocalHostOperationRecord,
  type LocalHostPushBranchOperationRecord,
  type LocalHostStructuredGitOperationRecord,
} from './operation-state.ts'
import {
  advanceLocalAgentRun,
  cancelLocalAgentRun,
  disposeLocalAgentRuns,
  inspectLocalAgentRun,
  resumeSucceededLocalAgentRun,
} from './agent-run.ts'
import { inspectLocalInterventionOpening } from './intervention-opening.ts'
import { inspectLocalProjectCommit } from './commit-inspection.ts'
import {
  advanceLocalGitPush,
  cancelLocalGitPush,
  createGitHubPushTransport,
  createTransportGitDirectory,
  recoverLocalGitPush,
} from './git-push.ts'
import { localGitPushInternalsFor } from './git-push-internals.ts'

/** Local Git observation, baseline, and operation resource limits. */
export interface Config {
  /** Closed non-interactive system credential adapter available to Push operations. */
  pushCredentialHelper?: GitCredentialHelperId
  /** Wall-clock bound for each Git process. */
  gitCommandTimeoutMs?: number
  /** TERM-to-KILL grace for each Git process tree. */
  gitTerminationGraceMs?: number
  /** Inclusive complete stdout bound for each Git process. */
  maxGitStdoutBytes?: number
  /** Inclusive complete stderr bound for each Git process. */
  maxGitStderrBytes?: number
  /** Maximum distinct paths in one complete repository inventory. */
  inventoryMaxEntries?: number
  /** Maximum exact path bytes across one complete repository inventory. */
  inventoryMaxPathBytes?: number
  /** Maximum raw Git stdout plus stderr bytes across one repository observation round. */
  inventoryMaxGitOutputBytes?: number
  /** Maximum retained raw evidence bytes from one inventory path. */
  inventoryMaxFileBytes?: number
  /** Maximum raw bytes read, including stability checks, across one repository inventory. */
  inventoryMaxTotalFileBytes?: number
  /** Wall-clock bound for one complete Git, filesystem, and Workspace observation round. */
  inventoryMaxCaptureMs?: number
  /** Maximum dirty entries in a complete inherited baseline. */
  baselineMaxEntries?: number
  /** Maximum sum of exact Git path bytes in a complete baseline. */
  baselineMaxPathBytes?: number
  /** Maximum allowlisted Git evidence bytes retained by one baseline. */
  baselineMaxGitOutputBytes?: number
  /** Maximum retained raw evidence bytes from one changed path. */
  baselineMaxFileBytes?: number
  /** Maximum bytes hashed across one complete baseline. */
  baselineMaxTotalFileBytes?: number
  /** Wall-clock bound for content baseline capture. */
  baselineMaxCaptureMs?: number
  /** Maximum source or target Git index bytes retained by one operation. */
  operationMaxIndexBytes?: number
  /** Maximum reflog bytes inspected while recovering one Commit publication. */
  operationMaxReflogBytes?: number
}

type ResolvedConfig = Required<Omit<Config, 'pushCredentialHelper'>>
  & Pick<Config, 'pushCredentialHelper'>

const MINIMUM_GIT_VERSION = [2, 45, 0] as const
const GIT_VERSION_DECODER = new TextDecoder('utf-8', { fatal: true })

/** Local Host Execution provider with durable operations and disposal-bound calls. */
export class LocalSakiHostExecution extends SakiHostExecution {
  static inject = [
    'agentPresets', 'agents', 'fs', 'sessionPersistence', 'sessions',
    'storageDomain', 'subprocess', 'workspaceRegistry',
  ]
  static Config: z<Config> = z.object({
    pushCredentialHelper: z.union([
      z.const('git-credential-manager'),
      z.const('git-credential-manager-core'),
    ]),
    gitCommandTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
    gitTerminationGraceMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(250),
    maxGitStdoutBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(4 * 1024 * 1024),
    maxGitStderrBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(64 * 1024),
    inventoryMaxEntries: z.natural().min(1).max(MAX_INVENTORY_ENTRIES).default(MAX_INVENTORY_ENTRIES),
    inventoryMaxPathBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(16 * 1024 * 1024),
    inventoryMaxGitOutputBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(16 * 1024 * 1024),
    inventoryMaxFileBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(64 * 1024 * 1024),
    inventoryMaxTotalFileBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(512 * 1024 * 1024),
    inventoryMaxCaptureMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    baselineMaxEntries: z.natural().min(1).max(MAX_INHERITED_BASELINE_ENTRIES).default(MAX_INHERITED_BASELINE_ENTRIES),
    baselineMaxPathBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(4 * 1024 * 1024),
    baselineMaxGitOutputBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(16 * 1024 * 1024),
    baselineMaxFileBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(16 * 1024 * 1024),
    baselineMaxTotalFileBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(64 * 1024 * 1024),
    baselineMaxCaptureMs: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
    operationMaxIndexBytes: z.natural()
      .min(MIN_OPERATION_MAX_INDEX_BYTES)
      .max(bufferConstants.MAX_LENGTH)
      .default(64 * 1024 * 1024),
    operationMaxReflogBytes: z.natural().min(1).max(bufferConstants.MAX_LENGTH).default(4 * 1024 * 1024),
  })

  private git!: GitRunner
  private operationDomain?: Domain<typeof sakiHostExecutionDomainSpec>
  private operationTable?: KvTable<HostOperationReference['id'], LocalHostOperationRecord>
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  private readonly liveOperations = new Map<HostOperationReference['id'], LiveHostOperation>()
  private readonly liveAgentRuns = new Map<SessionId, AgentHandle>()
  private readonly changedListeners = new Set<(change: HostOperationChange) => void>()
  private operationTail: Promise<void> = Promise.resolve()

  /** @param ctx - Local Host context. @param config - resolved Git observation and operation limits. */
  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    super(ctx)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Saki Local Host Execution disposed'))
      while (this.active.size > 0) await Promise.allSettled([...this.active])
      await disposeLocalAgentRuns(this.liveAgentRuns)
      this.liveOperations.clear()
      this.changedListeners.clear()
      await this.operationDomain?.close()
    }, 'saki-execution-local: abort and drain active inspections')
  }

  /** Resolve the system Git executable after required providers are active. */
  protected async [Service.init](): Promise<void> {
    this.operationDomain = await this.ctx.storageDomain.open(sakiHostExecutionDomainSpec)
    this.operationTable = this.operationDomain.table('operations')
    const executable = await this.ctx.subprocess.resolveExecutable('git')
    const runnerConfig = {
      maxStdoutBytes: this.config.maxGitStdoutBytes,
      maxStderrBytes: this.config.maxGitStderrBytes,
      timeoutMs: this.config.gitCommandTimeoutMs,
      terminationGraceMs: this.config.gitTerminationGraceMs,
    }
    const { stdout, stderr } = await runBoundedCommand(this.ctx.subprocess, {
      argv: [executable, '--version'],
      cwd: process.cwd(),
      env: gitInspectionEnvironment(),
      ...runnerConfig,
    }, this.lifetime.signal)
    assertSupportedGitVersion(stdout, stderr)
    this.git = new GitRunner(this.ctx.subprocess, executable, runnerConfig)
  }

  override async inspectProjectSelection(
    request: InspectProjectSelectionRequest,
    signal: AbortSignal,
  ): Promise<InspectProjectSelectionResult> {
    if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
    const fused = AbortSignal.any([signal, this.lifetime.signal])
    return await this.track(inspectLocalProjectSelection(
      this.ctx.fs,
      this.ctx.workspaceRegistry,
      this.git,
      this.config,
      request,
      fused,
      readLocalAdministrativeDirectoryIdentity,
    ))
  }

  override async inspectProject(
    request: InspectProjectRequest,
    signal: AbortSignal,
  ): Promise<InspectProjectResult> {
    if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
    const fused = AbortSignal.any([signal, this.lifetime.signal])
    return await this.track(this.inspectBoundProject(request.binding, fused))
  }

  override async inspectProjectCommit(
    request: InspectProjectCommitRequest,
    signal: AbortSignal,
  ): Promise<InspectProjectCommitResult> {
    if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
    const fused = AbortSignal.any([signal, this.lifetime.signal])
    return await this.track(inspectLocalProjectCommit({
      fs: this.ctx.fs,
      workspaces: this.ctx.workspaceRegistry,
      git: this.git,
      config: this.config,
      identityReader: readLocalAdministrativeDirectoryIdentity,
    }, request.binding, request.commitId, fused))
  }

  override async readDiff(
    binding: ActiveHostProjectBinding,
    request: ReadProjectDiffRequest,
    signal: AbortSignal,
  ): Promise<ReadProjectDiffResult> {
    if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
    const fused = AbortSignal.any([signal, this.lifetime.signal])
    return await this.track(readLocalProjectDiff({
      fs: this.ctx.fs,
      workspaces: this.ctx.workspaceRegistry,
      git: this.git,
      config: this.config,
      identityReader: readLocalAdministrativeDirectoryIdentity,
    }, binding, request, fused))
  }

  override async inspectInterventionOpening(
    request: InspectInterventionOpeningRequest,
    signal: AbortSignal,
  ): Promise<InterventionOpeningEvidence> {
    if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
    const fused = AbortSignal.any([signal, this.lifetime.signal])
    return await this.track(inspectLocalInterventionOpening(this.ctx.sessionPersistence, request, fused))
  }

  override async prepareOperation<K extends HostOperationKind>(
    request: HostOperationRequest<K>,
    admissionSource: HostOperationAdmissionSource,
    signal: AbortSignal,
  ): Promise<HostOperationReceipt<K>> {
    if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
    const fused = AbortSignal.any([signal, this.lifetime.signal])
    return await this.track(this.enqueueOperation(async () => {
      fused.throwIfAborted()
      const operationId = hostOperationIdFor(request.source)
      const table = this.requireOperationTable()
      const fingerprint = localHostOperationRequestFingerprint(request)
      const existing = table.get(operationId)
      if (existing !== undefined && existing.snapshot.requestFingerprint.digest !== fingerprint.digest) {
        return { ok: false, reason: 'source-conflict' }
      }
      if (existing === undefined && request.type === 'push-branch'
        && this.config.pushCredentialHelper === undefined) {
        return { ok: false, reason: 'unavailable' }
      }
      if (existing === undefined && request.type === 'commit' && request.expected.head.kind === 'commit'
        && request.expected.head.symbolicRef === undefined) {
        return { ok: false, reason: 'unavailable' }
      }
      const record = existing ?? createPreparedOperationRecord(request, operationId, fingerprint)
      if (existing === undefined) {
        await this.persistOperation(record)
      }
      fused.throwIfAborted()
      const acceptance = new LocalHostOperationAcceptance(
        record.snapshot.operation,
        record.snapshot.requestFingerprint.digest,
      )
      if (isTerminalHostOperation(record.snapshot)) this.liveOperations.delete(operationId)
      else this.liveOperations.set(operationId, { acceptance, admissionSource })
      return {
        ok: true,
        preparation: {
          operation: record.snapshot.operation as HostOperationReference<K>,
          preparationRevision: record.preparationRevision,
          requestFingerprint: record.snapshot.requestFingerprint,
        },
        snapshot: record.snapshot as HostOperationSnapshot<K>,
        acceptance,
      }
    }))
  }

  override async startOperation<K extends HostOperationKind>(
    operation: HostOperationReference<K>,
    acceptance: HostOperationAcceptance,
    signal: AbortSignal,
  ): Promise<HostOperationStartResult<K>> {
    if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
    const fused = AbortSignal.any([signal, this.lifetime.signal])
    return await this.track(this.enqueueOperation(async () => {
      fused.throwIfAborted()
      let record = this.requireOperation(operation)
      if (isTerminalHostOperation(record.snapshot)) {
        if (record.request.type === 'start-agent-run') {
          const inspected = await inspectLocalAgentRun(
            this.agentRunDependencies(),
            record as LocalHostAgentRunOperationRecord,
            next => this.persistOperation(next),
            fused,
          )
          this.liveOperations.delete(operation.id)
          return { ok: true, snapshot: inspected.snapshot as HostOperationSnapshot<K> }
        }
        if (record.request.type === 'push-branch') {
          this.liveOperations.delete(operation.id)
          return { ok: true, snapshot: record.snapshot as HostOperationSnapshot<K> }
        }
        const advanced = await advanceLocalGitMutation(
          this.gitMutationDependencies(),
          record as LocalHostStructuredGitOperationRecord,
          /* v8 ignore next -- terminal advance only cleans private artifacts;
           * its persistence sink is unreachable. */
          next => this.persistOperation(next),
          fused,
        )
        this.liveOperations.delete(operation.id)
        return { ok: true, snapshot: advanced.record.snapshot as HostOperationSnapshot<K> }
      }
      const live = this.liveOperations.get(operation.id)
      if (!(acceptance instanceof LocalHostOperationAcceptance)
        || live === undefined
        || live.acceptance !== acceptance
        || acceptance.operation.id !== operation.id
        || acceptance.requestFingerprint !== record.snapshot.requestFingerprint.digest) {
        return {
          ok: false,
          reason: 'acceptance-mismatch',
          snapshot: record.snapshot as HostOperationSnapshot<K>,
        }
      }
      if (record.request.type === 'push-branch' && this.config.pushCredentialHelper === undefined) {
        return {
          ok: false,
          reason: 'unavailable',
          snapshot: record.snapshot as HostOperationSnapshot<K>,
        }
      }
      const decision = await live.admissionSource({
        bindingId: record.request.expected.binding.id,
        bindingRevision: record.request.expected.binding.revision,
        preparation: {
          operation: record.snapshot.operation,
          preparationRevision: record.preparationRevision,
          requestFingerprint: record.snapshot.requestFingerprint,
        },
        source: record.request.source,
      }, fused)
      fused.throwIfAborted()
      if (decision.kind !== 'accepted') {
        return {
          ok: false,
          reason: decision.kind === 'denied' ? decision.reason : 'unavailable',
          snapshot: record.snapshot as HostOperationSnapshot<K>,
        }
      }
      if (record.snapshot.state === 'prepared') {
        const acceptedAt = Date.now()
        const snapshot: HostOperationSnapshot = {
          ...record.snapshot,
          state: 'accepted',
          revision: record.snapshot.revision + 1,
          admission: { kind: 'accepted', revision: decision.admissionRevision, acceptedAt },
          updatedAt: acceptedAt,
        }
        record = { ...record, snapshot }
        await this.persistOperation(record)
      } else if (record.snapshot.admission.kind !== 'accepted'
        || record.snapshot.admission.revision !== decision.admissionRevision) {
        return {
          ok: false,
          reason: 'not-current',
          snapshot: record.snapshot as HostOperationSnapshot<K>,
        }
      }
      const advanced = record.request.type === 'start-agent-run'
        ? await advanceLocalAgentRun(
          this.agentRunDependencies(),
          record as LocalHostAgentRunOperationRecord,
          next => this.persistOperation(next),
          fused,
        )
        : record.request.type === 'push-branch'
          ? await advanceLocalGitPush(
            this.gitPushDependencies(),
            record as LocalHostPushBranchOperationRecord,
            next => this.persistOperation(next),
            fused,
          )
          : await advanceLocalGitMutation(
            this.gitMutationDependencies(),
            record as LocalHostStructuredGitOperationRecord,
            next => this.persistOperation(next),
            fused,
          )
      if (advanced.kind === 'retryable') {
        return {
          ok: false,
          reason: advanced.reason,
          snapshot: advanced.record.snapshot as HostOperationSnapshot<K>,
        }
      }
      /* v8 ignore next -- every non-retryable mutation advance carries a terminal record;
       * fail loud if that engine contract regresses. */
      if (!isTerminalHostOperation(advanced.record.snapshot)) {
        throw new Error('Saki Local Host Operation advanced without a terminal snapshot')
      }
      this.liveOperations.delete(operation.id)
      return { ok: true, snapshot: advanced.record.snapshot as HostOperationSnapshot<K> }
    }))
  }

  override async resumeAgentRun(
    operation: HostOperationReference<'start-agent-run'>,
    request: StartAgentRunHostOperationRequest,
    signal: AbortSignal,
  ): Promise<void> {
    await this.withSerializedOperation(operation, signal, async (initial, fused) => {
      if (initial.request.type !== 'start-agent-run' || !isDeepStrictEqual(initial.request, request)) {
        throw new Error(`Saki Agent Run Host Operation '${operation.id}' disagrees with its exact recovery request`)
      }
      const record = await inspectLocalAgentRun(
        this.agentRunDependencies(),
        initial as LocalHostAgentRunOperationRecord,
        next => this.persistOperation(next),
        fused,
      )
      if (record.snapshot.state !== 'succeeded') {
        throw new Error(`Saki Agent Run Host Operation '${operation.id}' is not exactly succeeded`)
      }
      await resumeSucceededLocalAgentRun(this.agentRunDependencies(), record, fused)
    })
  }

  override async inspectOperation<K extends HostOperationKind>(
    operation: HostOperationReference<K>,
    signal: AbortSignal,
  ): Promise<HostOperationSnapshot<K>> {
    return await this.withSerializedOperation(operation, signal, async (initial, fused) => {
      let record = initial
      if (record.request.type === 'start-agent-run') {
        const inspected = await inspectLocalAgentRun(
          this.agentRunDependencies(),
          record as LocalHostAgentRunOperationRecord,
          next => this.persistOperation(next),
          fused,
        )
        if (isTerminalHostOperation(inspected.snapshot)) this.liveOperations.delete(operation.id)
        return inspected.snapshot as HostOperationSnapshot<K>
      }
      if (record.snapshot.state === 'publishing') {
        if (record.request.type === 'push-branch') {
          if (this.config.pushCredentialHelper !== undefined) {
            const recovered = await recoverLocalGitPush(
              this.gitPushDependencies(),
              record as LocalHostPushBranchOperationRecord,
              next => this.persistOperation(next),
              fused,
            )
            record = recovered.record
          }
        } else {
          const recovered = await recoverPublishingOperation(
            this.gitMutationDependencies(),
            record as LocalHostStructuredGitOperationRecord,
            next => this.persistOperation(next),
            fused,
          )
          record = recovered.record
        }
      }
      if (isTerminalHostOperation(record.snapshot)) {
        if (record.request.type !== 'push-branch') {
          await cleanupTerminalGitMutation(
            this.gitMutationDependencies(),
            record as LocalHostStructuredGitOperationRecord,
          )
        }
        this.liveOperations.delete(operation.id)
      }
      return record.snapshot as HostOperationSnapshot<K>
    })
  }

  override async cancelOperation<K extends HostOperationKind>(
    operation: HostOperationReference<K>,
    reason: HostOperationCancellationReason,
    signal: AbortSignal,
  ): Promise<HostOperationSnapshot<K>> {
    return await this.withSerializedOperation(operation, signal, async (initial, fused) => {
      let record = initial
      if (isTerminalHostOperation(record.snapshot)) {
        if (record.request.type === 'start-agent-run') {
          record = await inspectLocalAgentRun(
            this.agentRunDependencies(),
            record as LocalHostAgentRunOperationRecord,
            next => this.persistOperation(next),
            fused,
          )
        } else if (record.request.type !== 'push-branch') {
          await cleanupTerminalGitMutation(
            this.gitMutationDependencies(),
            record as LocalHostStructuredGitOperationRecord,
          )
        }
        this.liveOperations.delete(operation.id)
        return record.snapshot as HostOperationSnapshot<K>
      }
      if (record.snapshot.state === 'publishing') {
        if (record.request.type === 'start-agent-run') {
          const canceled = await cancelLocalAgentRun(
            this.agentRunDependencies(),
            record as LocalHostAgentRunOperationRecord,
            reason,
            next => this.persistOperation(next),
            fused,
          )
          if (isTerminalHostOperation(canceled.snapshot)) this.liveOperations.delete(operation.id)
          return canceled.snapshot as HostOperationSnapshot<K>
        }
        record = record.request.type === 'push-branch'
          ? await cancelLocalGitPush(
            record as LocalHostPushBranchOperationRecord,
            reason,
            next => this.persistOperation(next),
          )
          : await cancelPublishingOperation(
            this.gitMutationDependencies(),
            record as LocalHostStructuredGitOperationRecord,
            reason,
            next => this.persistOperation(next),
            fused,
          )
        if (isTerminalHostOperation(record.snapshot)) this.liveOperations.delete(operation.id)
        return record.snapshot as HostOperationSnapshot<K>
      }
      const completedAt = Date.now()
      const snapshot: HostOperationSnapshot = {
        ...hostOperationSnapshotCore(record.snapshot),
        state: 'canceled',
        revision: record.snapshot.revision + 1,
        completedAt,
        updatedAt: completedAt,
        reason,
        effect: 'none',
      } as HostOperationSnapshot
      await this.persistOperation({ ...record, snapshot })
      this.liveOperations.delete(operation.id)
      return snapshot as HostOperationSnapshot<K>
    })
  }

  override onChanged(listener: (change: HostOperationChange) => void): HostOperationChangedDisposer {
    this.changedListeners.add(listener)
    return () => { this.changedListeners.delete(listener) }
  }

  private async inspectBoundProject(
    binding: ActiveHostProjectBinding,
    signal: AbortSignal,
  ): Promise<InspectProjectResult> {
    let selected
    try {
      selected = await inspectStableLocalProjectSelection(
        this.ctx.fs,
        this.ctx.workspaceRegistry,
        this.git,
        this.config,
        {
          hostId: binding.hostId,
          directoryLocator: binding.expectedInspection.trusted.canonicalWorktreePath,
        },
        signal,
        readLocalAdministrativeDirectoryIdentity,
        {
          boundResource: {
            workspaceId: binding.workspaceId,
            trusted: binding.expectedInspection.trusted,
          },
        },
      )
    } catch (error) {
      if (error instanceof BoundProjectResourceMismatchError) {
        return { ok: false, reason: 'binding-stale' }
      }
      throw error
    }
    if (!selected.ok) return projectInspectionFailure(selected.reason)
    return completeBoundProjectInspection(binding, selected.inspection, () => {
      const preEffectBaseline = selected.inspection.projection.baseline
      return {
        observation: buildProjectGitStatusObservation(
          selected.inventory,
          selected.inspection,
          binding,
          signal,
          selected.status,
          preEffectBaseline,
          selected.unsupportedIndexState,
        ),
        preEffectBaseline,
      }
    })
  }

  private async track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.active.delete(tracked))
    this.active.add(tracked)
    return await tracked
  }

  private async withSerializedOperation<K extends HostOperationKind, T>(
    reference: HostOperationReference<K>,
    signal: AbortSignal,
    operation: (record: LocalHostOperationRecord, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
    const fused = AbortSignal.any([signal, this.lifetime.signal])
    return await this.track(this.enqueueOperation(async () => {
      fused.throwIfAborted()
      return await operation(this.requireOperation(reference), fused)
    }))
  }

  private requireOperationTable(): KvTable<HostOperationReference['id'], LocalHostOperationRecord> {
    if (this.operationTable === undefined) throw new Error('Saki Local Host Operation storage is not started')
    return this.operationTable
  }

  private requireOperation<K extends HostOperationKind>(
    reference: HostOperationReference<K>,
  ): LocalHostOperationRecord {
    const record = this.requireOperationTable().get(reference.id)
    if (record === undefined
      || record.snapshot.operation.hostId !== reference.hostId
      || record.snapshot.operation.type !== reference.type) {
      throw new Error(`unknown Saki Host Operation '${reference.id}'`)
    }
    return record
  }

  private gitMutationDependencies() {
    const internals = localGitMutationInternalsFor(this.ctx)
    return {
      fs: this.ctx.fs,
      workspaces: this.ctx.workspaceRegistry,
      git: this.git,
      config: this.config,
      identityReader: readLocalAdministrativeDirectoryIdentity,
      isOperationDurable: (record: LocalHostStructuredGitOperationRecord) => isDeepStrictEqual(
        this.requireOperationTable().get(record.snapshot.operation.id),
        record,
      ),
      ...(internals === undefined ? {} : { internals }),
    }
  }

  private gitPushDependencies() {
    const internals = localGitPushInternalsFor(this.ctx)
    const transport = internals?.transport
    const credential = this.config.pushCredentialHelper
    if (credential === undefined) throw new Error('Saki Local Host Push credential adapter is unavailable')
    return {
      fs: this.ctx.fs,
      workspaces: this.ctx.workspaceRegistry,
      git: this.git,
      config: this.config,
      identityReader: readLocalAdministrativeDirectoryIdentity,
      credential,
      transport: transport ?? createGitHubPushTransport(this.git),
      createTransportGitDirectory: internals?.createTransportGitDirectory ?? createTransportGitDirectory,
    }
  }

  private agentRunDependencies() {
    return {
      ctx: this.ctx,
      agents: this.ctx.agents,
      agentPresets: this.ctx.agentPresets,
      sessions: this.ctx.sessions,
      sessionPersistence: this.ctx.sessionPersistence,
      handles: this.liveAgentRuns,
      world: this.gitMutationDependencies(),
    }
  }

  private async persistOperation(record: LocalHostOperationRecord): Promise<void> {
    const validated = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse(record)
    await this.requireOperationTable().put(validated.snapshot.operation.id, validated)
    this.emitOperationChanged(validated.snapshot)
  }

  private emitOperationChanged(snapshot: HostOperationSnapshot): void {
    const change = { operation: snapshot.operation, revision: snapshot.revision }
    for (const listener of [...this.changedListeners]) {
      try {
        listener(change)
      } catch {
        this.ctx.logger.warn('[saki-execution-local] Host Operation change listener failed')
      }
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

interface LiveHostOperation {
  readonly acceptance: LocalHostOperationAcceptance
  readonly admissionSource: HostOperationAdmissionSource
}

class LocalHostOperationAcceptance extends HostOperationAcceptance {
  /** @param operation - exact prepared operation. @param requestFingerprint - immutable request identity. */
  constructor(
    readonly operation: HostOperationReference,
    readonly requestFingerprint: string,
  ) {
    super()
  }
}

function hostOperationIdFor(source: HostOperationRequest['source']): HostOperationReference['id'] {
  const id = source.kind === 'control-intent' ? source.intentId : source.dispatchId
  return id.replace(/^(?:intent|dispatch)-/u, 'host-operation-') as HostOperationReference['id']
}

function createPreparedOperationRecord<K extends HostOperationKind>(
  request: HostOperationRequest<K>,
  id: HostOperationReference['id'],
  requestFingerprint: ReturnType<typeof localHostOperationRequestFingerprint>,
): LocalHostOperationRecord {
  const preparedAt = Date.now()
  const operation = { id, hostId: request.expected.binding.hostId, type: request.type }
  return {
    schemaVersion: 4,
    request,
    preparationRevision: 0,
    snapshot: {
      operation,
      revision: 0,
      source: request.source,
      requestFingerprint,
      bindingId: request.expected.binding.id,
      bindingRevision: request.expected.binding.revision,
      preparedAt,
      updatedAt: preparedAt,
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    },
  } as LocalHostOperationRecord
}

function isTerminalHostOperation(snapshot: HostOperationSnapshot): boolean {
  return snapshot.state === 'succeeded'
    || snapshot.state === 'failed'
    || snapshot.state === 'canceled'
    || snapshot.state === 'reconciliation-required'
}

/**
 * Reject Git versions that cannot provide the absolute, NUL-framed worktree
 * observations required by this provider.
 * @param bytes - complete bounded `git --version` stdout.
 * @param stderr - complete bounded `git --version` stderr.
 * @returns nothing after accepting Git 2.45 or newer.
 */
export function assertSupportedGitVersion(bytes: Uint8Array, stderr: Uint8Array): void {
  if (stderr.byteLength !== 0) throw new Error('Saki Local Host Execution requires Git 2.45 or newer')
  let text: string
  try {
    text = GIT_VERSION_DECODER.decode(bytes)
  } catch {
    throw new Error('Saki Local Host Execution requires Git 2.45 or newer')
  }
  const match = /^git version ([0-9]+)\.([0-9]+)(?:\.([0-9]+))?[^\r\n]*\r?\n$/u.exec(text)
  if (match === null) throw new Error('Saki Local Host Execution requires Git 2.45 or newer')
  const [, majorText, minorText, patchText] = match
  const [minimumMajor, minimumMinor, minimumPatch] = MINIMUM_GIT_VERSION
  const major = Number(majorText)
  const minor = Number(minorText)
  const patch = Number(patchText ?? 0)
  if (major > minimumMajor
    || (major === minimumMajor && minor > minimumMinor)
    || (major === minimumMajor && minor === minimumMinor && patch >= minimumPatch)) return
  throw new Error('Saki Local Host Execution requires Git 2.45 or newer')
}

export { GitCommandError } from './git-runner.ts'
export { MIN_OPERATION_MAX_INDEX_BYTES } from './operation-state.ts'
export { sanitizeRemote } from './inspection.ts'
export {
  sakiHostExecutionDomainMigrations,
  sakiHostExecutionDomainSpec,
  sakiHostExecutionV1DomainSpec,
  sakiHostExecutionV2DomainSpec,
  sakiHostExecutionV3DomainSpec,
} from './operation-state.ts'
export type {
  LocalHostGitOperationRecordV1,
  LocalHostOperationRecord,
  LocalHostOperationRecordV2,
  LocalHostOperationRecordV3,
} from './operation-state.ts'

export default LocalSakiHostExecution
