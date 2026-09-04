/** GitHub synchronization configuration lifecycle and Project Settings projection. */

import { randomUUID } from 'node:crypto'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  GitHubProviderError,
  githubProjectBoardScanCandidateSchema,
  type SakiGitHub,
  type GitHubProjectBoardScanCandidate,
  type GitHubProjectFieldFact,
  type GitHubProjectItemFact,
  type GitHubProjectOptionId,
  type GitHubRateObservation,
} from '@breakfastdapaidang/saki-github'
import { SAKI_BOARD_WORK_ITEM_LIMIT } from './constants.ts'
import {
  configureGitHubSynchronizationIntentSchema,
  githubProjectSyncRecordSchema,
  githubSynchronizationConfigurationIntentRecordSchema,
  githubSynchronizationConfigurationSchema,
  sakiGitHubScanFailureSchema,
} from './spec.ts'
import type {
  GitHubProjectSyncRecord,
  GitHubSynchronizationConfigurationIntentRecord,
  RegistrationActor,
} from './spec.ts'
import type {
  ConfigureGitHubSynchronizationIntent,
  GitHubSynchronizationConfiguration,
  GitHubSynchronizationConfigurationField,
  SakiControlIntentId,
  SakiBoardWorkItemId,
  SakiBoardMutationUnavailableReason,
  SakiBoardProjection,
  SakiBoardStatus,
  SakiConfirmedBoardProjection,
  SakiDevelopmentProjectId,
  SakiGitHubDueScan,
  SakiGitHubMappingHealthProjection,
  SakiGitHubMappingIssue,
  SakiGitHubRateLimitProjection,
  SakiGitHubScanAttemptId,
  SakiGitHubScanBeginResult,
  SakiGitHubScanFailResult,
  SakiGitHubScanFailure,
  SakiGitHubFreshBoardScanResult,
  SakiGitHubScanPublishResult,
  SakiGitHubScanRequestFenceResult,
  SakiGitHubScanStateProjection,
  SakiGitHubSynchronizationCoordinator,
  SakiGitHubSynchronizationFailureProjection,
  SakiIntentReceipt,
  SakiIntentReceiptId,
  SakiProjectSettingsProjection,
} from './types.ts'
import { enqueueKeyedOperation } from './keyed-operation.ts'
import { projectGitHubFailure } from './github-failure-projection.ts'
import {
  boardWorkItemId,
  joinedBoardRemoteFingerprint,
  unjoinedBoardRemoteFingerprint,
} from './work-item-mapping.ts'

/** Durable aggregate table keyed directly by its owning Development Project. */
export type GitHubProjectSyncTable = KvTable<SakiDevelopmentProjectId, GitHubProjectSyncRecord>
/** Durable configuration Intent table keyed by the caller's idempotency identity. */
export type GitHubSynchronizationConfigurationIntentTable = KvTable<
  SakiControlIntentId,
  GitHubSynchronizationConfigurationIntentRecord
>

interface GitHubProjectSynchronizationOptions {
  readonly syncTable: GitHubProjectSyncTable
  readonly intentTable: GitHubSynchronizationConfigurationIntentTable
  readonly workItemRecovery: (
    projectId: SakiDevelopmentProjectId,
    workItemId: SakiBoardWorkItemId,
  ) => GitHubWorkItemRecoveryMemory | undefined
  readonly installationId: RegistrationActor['installationId']
  readonly projectExists: (projectId: SakiDevelopmentProjectId) => boolean
  readonly authorityCurrent: (actor: RegistrationActor) => boolean
  readonly validateActorReference: (actor: RegistrationActor) => void
}

/** Narrow targeted Status memory that a complete scan may fold into one terminal Work Item. */
export interface GitHubWorkItemRecoveryMemory {
  readonly latestNonTerminalStatus: Exclude<SakiBoardStatus, 'done' | 'canceled'> | null
  readonly observedAt: number
  readonly repositoryId: GitHubProjectBoardScanCandidate['repository']['id']
  readonly repositoryDatabaseId: GitHubProjectBoardScanCandidate['repository']['databaseId']
  readonly projectId: GitHubProjectBoardScanCandidate['project']['id']
  readonly statusFieldId: GitHubProjectBoardScanCandidate['statusFieldId']
}

/** Detached active mapping and confirmed Board evidence used to derive one mutation target. */
export interface GitHubWorkItemMutationContext {
  readonly synchronizationRevision: number
  readonly mappingRevision: number
  readonly checkpointObservedAt: number
  readonly configuration: GitHubSynchronizationConfiguration
  readonly confirmedBoard: SakiConfirmedBoardProjection
}

/** Exact context lookup result before browser input can be mapped to GitHub authority ids. */
export type GitHubWorkItemMutationContextResult =
  | { readonly ok: true; readonly context: GitHubWorkItemMutationContext }
  | { readonly ok: false; readonly reason: 'not-found' }
  | {
    readonly ok: false
    readonly reason: 'unavailable'
    readonly reasons: readonly SakiBoardMutationUnavailableReason[]
  }

type AvailableGitHubWorkItemMutationRecord = GitHubProjectSyncRecord & {
  readonly active: NonNullable<GitHubProjectSyncRecord['active']>
  readonly checkpoint: NonNullable<GitHubProjectSyncRecord['checkpoint']>
  readonly confirmedBoard: NonNullable<GitHubProjectSyncRecord['confirmedBoard']>
}

/** Parsed and cross-checked synchronization records suitable for deterministic recovery. */
export interface ValidatedGitHubSynchronizationState {
  readonly syncRecords: readonly GitHubProjectSyncRecord[]
  readonly intents: readonly GitHubSynchronizationConfigurationIntentRecord[]
}

class SynchronizationConflict extends Error {
  readonly reason:
    | 'expected-revision'
    | 'project-not-found'
    | 'configuration-incomplete'
    | 'configuration-unchanged'

  constructor(reason: SynchronizationConflict['reason']) {
    super(reason)
    this.reason = reason
  }
}

const CONFIGURATION_FIELDS = Object.freeze([
  'appId',
  'githubInstallationId',
  'accountNodeId',
  'repositoryNodeId',
  'repositoryDatabaseId',
  'projectNodeId',
  'credentialRef',
  'statusFieldNodeId',
  'statusOptionNodeIds',
  'activePollIntervalMs',
  'backgroundPollIntervalMs',
  'rateLimitReserve',
] as const satisfies readonly GitHubSynchronizationConfigurationField[])

const STATUS_MAPPING_FIELDS = Object.freeze([
  ['inbox', 'inbox'],
  ['backlog', 'backlog'],
  ['ready', 'ready'],
  ['inProgress', 'in-progress'],
  ['inReview', 'in-review'],
  ['done', 'done'],
  ['canceled', 'canceled'],
] as const satisfies readonly (readonly [
  keyof GitHubSynchronizationConfiguration['statusOptionNodeIds'],
  SakiBoardStatus,
])[])

/** Recoverable field-scoped configuration owner behind the control-plane query and Intent interface. */
export class GitHubProjectSynchronization implements SakiGitHubSynchronizationCoordinator {
  private readonly intentOperationTails = new Map<SakiControlIntentId, Promise<void>>()
  private readonly projectOperationTails = new Map<SakiDevelopmentProjectId, Promise<void>>()

  /** @param options - durable tables and current authority/project resolvers. */
  constructor(private readonly options: GitHubProjectSynchronizationOptions) {}

  /**
   * Validate all synchronization records before startup recovery runs.
   * @returns parsed detached records suitable for deterministic recovery.
   */
  validateDurableState(): ValidatedGitHubSynchronizationState {
    return validateGitHubSynchronizationDurableState(
      this.options.syncTable,
      this.options.intentTable,
      this.options.installationId,
      this.options.projectExists,
      this.options.validateActorReference,
    )
  }

  /**
   * Resume prepared configuration Intents after the complete current state was validated.
   * @param state - records returned by {@link validateDurableState}.
   * @param signal - startup lifetime.
   */
  async initializeValidated(state: ValidatedGitHubSynchronizationState, signal: AbortSignal): Promise<void> {
    for (const intent of state.intents) {
      signal.throwIfAborted()
      if (intent.phase === 'prepared') {
        await this.enqueueProjectOperation(intent.payload.intent.projectId, () => this.resume(intent.id, signal))
      }
    }
    for (const sync of state.syncRecords) {
      signal.throwIfAborted()
      await this.enqueueProjectOperation(sync.id, () => this.recoverStartup(sync.id, signal))
    }
    this.validateDurableState()
  }

  /**
   * Save or replay one immutable field-scoped candidate.
   * @param intent - parsed caller input.
   * @param actor - current server-derived authority evidence for a new Intent.
   * @param signal - caller lifetime.
   * @returns stable saved or terminal receipt.
   */
  async configure(
    intent: ConfigureGitHubSynchronizationIntent,
    actor: RegistrationActor,
    signal: AbortSignal,
  ): Promise<SakiIntentReceipt<'configure-github-synchronization'>> {
    const parsedIntent = configureGitHubSynchronizationIntentSchema.parse(intent) as ConfigureGitHubSynchronizationIntent
    return await this.enqueueIntentOperation(parsedIntent.intentId, () => this.enqueueProjectOperation(
      parsedIntent.projectId,
      async () => {
        signal.throwIfAborted()
        const existing = this.options.intentTable.get(parsedIntent.intentId)
        if (existing !== undefined) {
          const parsed = githubSynchronizationConfigurationIntentRecordSchema.parse(existing)
          if (!sameIncomingIntent(parsed, parsedIntent)) return { ok: false, reason: 'conflict' }
          return await this.resume(parsed.id, signal)
        }
        const retainedPrepared = [...this.options.intentTable.entries()]
          .map(([, value]) => githubSynchronizationConfigurationIntentRecordSchema.parse(value))
          .find(value => value.phase === 'prepared'
            && value.payload.intent.projectId === parsedIntent.projectId)
        if (retainedPrepared !== undefined) await this.resume(retainedPrepared.id, signal)
        const payload = { intent: parsedIntent, actor }
        const now = Date.now()
        const record = githubSynchronizationConfigurationIntentRecordSchema.parse({
          id: parsedIntent.intentId,
          schemaVersion: 1,
          revision: 0,
          receiptId: receiptId(parsedIntent.intentId),
          payloadDigest: canonicalDigest('saki/configure-github-synchronization/v1', payload),
          payload,
          phase: 'prepared',
          createdAt: now,
          updatedAt: now,
        })
        await this.options.intentTable.put(record.id, record)
        return await this.resume(record.id, signal)
      },
    ))
  }

  /** @inheritdoc */
  async requestScan(
    projectId: SakiDevelopmentProjectId,
    priority: 'interactive' | 'background',
    reason: 'startup' | 'configuration' | 'poll' | 'interactive' | 'retry',
    attemptAt: number,
    signal: AbortSignal,
  ): Promise<'scheduled' | 'not-found' | 'unconfigured'> {
    const result = await this.scheduleScan(projectId, priority, reason, attemptAt, signal)
    return result.state
  }

  /** @inheritdoc */
  async requestScanAfterCurrent(
    projectId: SakiDevelopmentProjectId,
    signal: AbortSignal,
  ): Promise<SakiGitHubScanRequestFenceResult> {
    return await this.scheduleScan(projectId, 'interactive', 'interactive', Date.now(), signal)
  }

  private async scheduleScan(
    projectId: SakiDevelopmentProjectId,
    priority: 'interactive' | 'background',
    reason: 'startup' | 'configuration' | 'poll' | 'interactive' | 'retry',
    attemptAt: number,
    signal: AbortSignal,
  ): Promise<SakiGitHubScanRequestFenceResult> {
    return await this.enqueueProjectOperation(projectId, async () => {
      signal.throwIfAborted()
      if (!this.options.projectExists(projectId)) return { state: 'not-found' }
      const currentValue = this.options.syncTable.get(projectId)
      if (currentValue === undefined) return { state: 'unconfigured' }
      const current = githubProjectSyncRecordSchema.parse(currentValue)
      if (current.pending === undefined && current.active === undefined) return { state: 'unconfigured' }
      await this.options.syncTable.update(projectId, (storedValue) => {
        const stored = githubProjectSyncRecordSchema.parse(storedValue)
        return githubProjectSyncRecordSchema.parse({
          ...stored,
          nextScanAttempt: mergeScanRequest(stored.nextScanAttempt, { priority, reason, attemptAt }),
        })
      })
      return {
        state: 'scheduled',
        ...(current.inFlightAttempt === undefined
          ? {}
          : { preexistingAttemptId: current.inFlightAttempt.attemptId }),
      }
    })
  }

  /** @inheritdoc */
  listDueScans(now: number): readonly SakiGitHubDueScan[] {
    const due: SakiGitHubDueScan[] = []
    for (const [projectId, value] of this.options.syncTable.entries()) {
      const record = githubProjectSyncRecordSchema.parse(value)
      if (record.inFlightAttempt !== undefined && record.inFlightAttempt.expiresAt <= now) {
        const retry = mergeScanRequest(record.nextScanAttempt, {
          priority: record.inFlightAttempt.priority,
          reason: 'retry',
          attemptAt: record.inFlightAttempt.expiresAt,
        })
        due.push({ projectId, ...retry })
        continue
      }
      if (record.inFlightAttempt === undefined
        && record.nextScanAttempt !== undefined
        && record.nextScanAttempt.attemptAt <= now) {
        due.push({ projectId, ...record.nextScanAttempt })
      }
    }
    return due.sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority)
      || left.attemptAt - right.attemptAt
      || left.projectId.localeCompare(right.projectId))
  }

  /**
   * Read the earliest time at which the contained Consumer must recheck durable scan work.
   * @returns the next scheduled attempt or lease expiry, or `undefined` when no work exists.
   */
  nextScanAt(): number | undefined {
    let next: number | undefined
    for (const [, value] of this.options.syncTable.entries()) {
      const record = githubProjectSyncRecordSchema.parse(value)
      const candidate = record.inFlightAttempt?.expiresAt ?? record.nextScanAttempt?.attemptAt
      if (candidate !== undefined && (next === undefined || candidate < next)) next = candidate
    }
    return next
  }

  /** @inheritdoc */
  async beginScan(
    projectId: SakiDevelopmentProjectId,
    priority: 'interactive' | 'background',
    expiresAt: number,
    signal: AbortSignal,
  ): Promise<SakiGitHubScanBeginResult> {
    return await this.enqueueProjectOperation(projectId, async () => {
      signal.throwIfAborted()
      if (!this.options.projectExists(projectId)) return { ok: false, reason: 'not-found' }
      const currentValue = this.options.syncTable.get(projectId)
      if (currentValue === undefined) return { ok: false, reason: 'unconfigured' }
      const current = githubProjectSyncRecordSchema.parse(currentValue)
      const configuration = current.pending?.configuration ?? current.active?.configuration
      const configurationRevision = current.pending?.revision ?? current.active?.revision
      if (configuration === undefined || configurationRevision === undefined) {
        return { ok: false, reason: 'unconfigured' }
      }
      const now = Date.now()
      if (current.inFlightAttempt !== undefined && current.inFlightAttempt.expiresAt > now) {
        return { ok: false, reason: 'in-flight' }
      }
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
        throw new Error('GitHub scan expiry must be a future safe-integer timestamp')
      }
      const attemptId = `scan-attempt-${randomUUID()}` as SakiGitHubScanAttemptId
      const request = scanRequest(configuration, priority)
      await this.options.syncTable.update(projectId, (storedValue) => {
        const stored = githubProjectSyncRecordSchema.parse(storedValue)
        const storedConfigurationRevision = stored.pending?.revision ?? stored.active?.revision
        if (storedConfigurationRevision !== configurationRevision) {
          throw new Error(`GitHub Project sync '${projectId}' changed before scan admission`)
        }
        const expiredFailure = stored.inFlightAttempt !== undefined
          ? currentFailure(stored.inFlightAttempt, { kind: 'attempt', reason: 'expired' }, now)
          : stored.currentFailure
        const { nextScanAttempt: _nextScanAttempt, ...withoutSchedule } = stored
        return githubProjectSyncRecordSchema.parse({
          ...withoutSchedule,
          ...(stored.pending === undefined ? {} : {
            pending: { ...stored.pending, state: 'activating' },
          }),
          inFlightAttempt: {
            attemptId,
            priority,
            configurationRevision,
            startedAt: now,
            expiresAt,
          },
          ...(expiredFailure === undefined ? {} : { currentFailure: expiredFailure }),
        })
      })
      return {
        ok: true,
        lease: { attemptId, projectId, configurationRevision, expiresAt, request },
      }
    })
  }

  /** @inheritdoc */
  async publishScan(
    projectId: SakiDevelopmentProjectId,
    attemptId: SakiGitHubScanAttemptId,
    candidate: GitHubProjectBoardScanCandidate,
    signal: AbortSignal,
  ): Promise<SakiGitHubScanPublishResult> {
    return await this.enqueueProjectOperation(projectId, async () => {
      signal.throwIfAborted()
      const currentValue = this.options.syncTable.get(projectId)
      if (currentValue === undefined) return { state: 'stale' }
      const current = githubProjectSyncRecordSchema.parse(currentValue)
      const attempt = current.inFlightAttempt
      if (attempt?.attemptId !== attemptId) return { state: 'stale' }
      const now = Date.now()
      if (attempt.expiresAt <= now) {
        const failure = { kind: 'attempt', reason: 'expired' } as const
        await this.completeFailure(current, attemptId, failure, now)
        return { state: 'failed', failure }
      }
      const configuration = currentConfiguration(current)
      const admitted = githubProjectBoardScanCandidateSchema.safeParse(candidate)
      if (!admitted.success) {
        const failure = { kind: 'candidate', reason: 'invalid-candidate' } as const
        await this.completeFailure(current, attemptId, failure, now)
        return { state: 'failed', failure }
      }
      if (!candidateTargetsConfiguration(admitted.data, configuration)) {
        const failure = { kind: 'candidate', reason: 'target-mismatch' } as const
        await this.completeFailure(current, attemptId, failure, now)
        return { state: 'failed', failure }
      }
      if (hasDuplicateConfiguredRepositoryIssue(admitted.data, configuration)) {
        const failure = { kind: 'candidate', reason: 'invalid-candidate' } as const
        await this.completeFailure(current, attemptId, failure, now)
        return { state: 'failed', failure }
      }
      const observedBoardWorkItems = boardWorkItemCount(admitted.data, configuration)
      if (observedBoardWorkItems > SAKI_BOARD_WORK_ITEM_LIMIT) {
        const failure = {
          kind: 'capacity',
          resource: 'board-work-items',
          limit: SAKI_BOARD_WORK_ITEM_LIMIT,
          observed: observedBoardWorkItems,
        } as const
        await this.completeFailure(current, attemptId, failure, now)
        return { state: 'failed', failure }
      }
      const mapped = mapBoardCandidate(
        admitted.data,
        configuration,
        current.nextBoardGeneration,
        attempt.configurationRevision,
        current.confirmedBoard,
        (workItemId) => {
          const recovery = this.options.workItemRecovery(projectId, workItemId)
          return recovery !== undefined
            && current.checkpoint !== undefined
            && recovery.observedAt >= current.checkpoint.observedAt
            && recovery.observedAt <= admitted.data.observedAt
            && recovery.repositoryId === admitted.data.repository.id
            && recovery.repositoryDatabaseId === admitted.data.repository.databaseId
            && recovery.projectId === admitted.data.project.id
            && recovery.statusFieldId === admitted.data.statusFieldId
            ? recovery.latestNonTerminalStatus
            : undefined
        },
      )
      if (!mapped.ok) {
        const failure = { kind: 'mapping', issues: mapped.issues } as const
        await this.completeFailure(current, attemptId, failure, now)
        return current.pending?.revision === attempt.configurationRevision
          ? { state: 'activation-failed', issues: mapped.issues }
          : { state: 'failed', failure }
      }
      const generation = current.nextBoardGeneration
      const rateLimit = summarizeRateLimit(admitted.data.rateObservations)
      await this.options.syncTable.update(projectId, (storedValue) => {
        const stored = githubProjectSyncRecordSchema.parse(storedValue)
        /* v8 ignore next 3 -- every scan write for one Project runs behind the same operation tail. */
        if (stored.inFlightAttempt?.attemptId !== attemptId
          || stored.inFlightAttempt.configurationRevision !== attempt.configurationRevision) {
          return stored
        }
        const activating = stored.pending?.revision === attempt.configurationRevision
          ? stored.pending
          : undefined
        const active = activating === undefined
          ? stored.active
          : {
            revision: activating.revision,
            configuration: activating.configuration,
            acceptedIntentId: activating.acceptedIntentId,
            receiptId: activating.receiptId,
            activatedAt: now,
          }
        /* v8 ignore next -- the in-flight revision belongs to either the parsed pending or active configuration. */
        if (active === undefined) throw new Error(`GitHub Project sync '${projectId}' lost its scan configuration`)
        const {
          pending: _pending,
          nextScanAttempt: _nextScanAttempt,
          inFlightAttempt: _inFlightAttempt,
          currentFailure: _currentFailure,
          ...stable
        } = stored
        return githubProjectSyncRecordSchema.parse({
          ...stable,
          active,
          confirmedBoard: mapped.board,
          checkpoint: {
            generation,
            configurationRevision: attempt.configurationRevision,
            attemptId,
            installationId: admitted.data.installation.installationId,
            repositoryId: admitted.data.repository.id,
            projectId: admitted.data.project.id,
            statusFieldId: admitted.data.statusFieldId,
            sourceFingerprint: admitted.data.fingerprint,
            observedAt: admitted.data.observedAt,
            confirmedAt: now,
            rateLimit,
          },
          nextBoardGeneration: generation + 1,
          nextScanAttempt: mergeScanRequest(stored.nextScanAttempt, {
            priority: 'background',
            reason: 'poll',
            attemptAt: nextSuccessfulPollAt(now, active.configuration, rateLimit),
          }),
        })
      })
      return { state: 'published', generation, configurationRevision: attempt.configurationRevision }
    })
  }

  /** @inheritdoc */
  async failScan(
    projectId: SakiDevelopmentProjectId,
    attemptId: SakiGitHubScanAttemptId,
    failure: SakiGitHubScanFailure,
    signal: AbortSignal,
  ): Promise<SakiGitHubScanFailResult> {
    return await this.enqueueProjectOperation(projectId, async () => {
      signal.throwIfAborted()
      const currentValue = this.options.syncTable.get(projectId)
      if (currentValue === undefined) return { state: 'stale' }
      const current = githubProjectSyncRecordSchema.parse(currentValue)
      if (current.inFlightAttempt?.attemptId !== attemptId) return { state: 'stale' }
      const configuration = currentConfiguration(current)
      const admitted = normalizeScanFailure(sakiGitHubScanFailureSchema.parse(failure), configuration)
      await this.completeFailure(current, attemptId, admitted, Date.now())
      return { state: 'failed' }
    })
  }

  /**
   * Project one last complete confirmed Board without exposing partial scan state.
   * @param projectId - selected Development Project.
   * @returns Board projection, or `not-found` for an unknown Project.
   */
  board(projectId: SakiDevelopmentProjectId): SakiBoardProjection | 'not-found' {
    if (!this.options.projectExists(projectId)) return 'not-found'
    return boardProjection(projectId, this.options.syncTable.get(projectId), Date.now())
  }

  /**
   * Resolve the active server-owned GitHub target and a detached confirmed Board.
   * @param projectId - selected Development Project.
   * @returns a mutation context only when configuration, mapping, and checkpoint are active.
   */
  mutationContext(projectId: SakiDevelopmentProjectId): GitHubWorkItemMutationContextResult {
    if (!this.options.projectExists(projectId)) return { ok: false, reason: 'not-found' }
    const value = this.options.syncTable.get(projectId)
    const record = value === undefined ? undefined : githubProjectSyncRecordSchema.parse(value)
    const reasons = mutationUnavailableReasons(record, mappingHealth(record))
    if (reasons.length > 0) return { ok: false, reason: 'unavailable', reasons }
    const available = record as AvailableGitHubWorkItemMutationRecord
    return {
      ok: true,
      context: {
        synchronizationRevision: available.revision,
        mappingRevision: available.checkpoint.configurationRevision,
        checkpointObservedAt: available.checkpoint.observedAt,
        configuration: available.active.configuration,
        confirmedBoard: available.confirmedBoard,
      },
    }
  }

  /**
   * Project the currently saved and active synchronization configuration.
   * @param projectId - selected Development Project.
   * @returns settings projection, or `not-found` for an unknown Project.
   */
  projectSettings(projectId: SakiDevelopmentProjectId): SakiProjectSettingsProjection | 'not-found' {
    if (!this.options.projectExists(projectId)) return 'not-found'
    const record = this.options.syncTable.get(projectId)
    const parsed = record === undefined ? undefined : githubProjectSyncRecordSchema.parse(record)
    const common = synchronizationProjection(parsed, Date.now())
    if (parsed === undefined) {
      return { type: 'project-settings', projectId, synchronization: common }
    }
    const state = parsed.pending?.state
      ?? (parsed.active === undefined ? 'unconfigured' : 'activated')
    return {
      type: 'project-settings',
      projectId,
      synchronization: {
        ...common,
        ...(parsed.active === undefined ? {} : {
          active: {
            revision: parsed.active.revision,
            configuration: parsed.active.configuration,
            activatedAt: parsed.active.activatedAt,
          },
        }),
        ...(parsed.pending === undefined ? {} : {
          pending: {
            revision: parsed.pending.revision,
            changedFields: parsed.pending.changedFields,
            state: parsed.pending.state,
            configuration: parsed.pending.configuration,
            savedAt: parsed.pending.savedAt,
          },
        }),
        state,
      },
    }
  }

  private async resume(
    intentId: SakiControlIntentId,
    signal: AbortSignal,
  ): Promise<SakiIntentReceipt<'configure-github-synchronization'>> {
    signal.throwIfAborted()
    let record = this.requireIntent(intentId)
    if (record.phase !== 'prepared') return receiptFor(record)
    const currentValue = this.options.syncTable.get(record.payload.intent.projectId)
    const current = currentValue === undefined ? undefined : githubProjectSyncRecordSchema.parse(currentValue)
    const replay = current === undefined ? undefined : acceptedCandidate(current, record.id)
    if (replay !== undefined) {
      record = await this.transition(record, {
        phase: 'saved',
        candidateRevision: replay.candidateRevision,
        synchronizationRevision: replay.synchronizationRevision,
      })
      return receiptFor(record)
    }
    if (!this.options.authorityCurrent(record.payload.actor)) {
      record = await this.transition(record, { phase: 'failure', terminalReason: 'authority' })
      return receiptFor(record)
    }
    try {
      const committed = await this.commitCandidate(record)
      record = await this.transition(record, {
        phase: 'saved',
        candidateRevision: committed.candidateRevision,
        synchronizationRevision: committed.synchronizationRevision,
      })
    } catch (error) {
      if (!(error instanceof SynchronizationConflict)) throw error
      record = await this.transition(record, { phase: 'conflict', terminalReason: error.reason })
    }
    return receiptFor(record)
  }

  private async commitCandidate(
    intentRecord: GitHubSynchronizationConfigurationIntentRecord,
  ): Promise<{ readonly candidateRevision: number; readonly synchronizationRevision: number }> {
    const intent = intentRecord.payload.intent as ConfigureGitHubSynchronizationIntent
    if (!this.options.projectExists(intent.projectId)) throw new SynchronizationConflict('project-not-found')
    const currentValue = this.options.syncTable.get(intent.projectId)
    const current = currentValue === undefined ? undefined : githubProjectSyncRecordSchema.parse(currentValue)
    if ((current?.revision ?? 0) !== intent.expectedSynchronizationRevision) {
      throw new SynchronizationConflict('expected-revision')
    }
    const base = current?.pending?.configuration ?? current?.active?.configuration
    const configuration = githubSynchronizationConfigurationSchema.safeParse({
      ...base,
      ...intent.patch,
    })
    if (!configuration.success) throw new SynchronizationConflict('configuration-incomplete')
    const pendingChangedFields = changedFields(configuration.data, current?.active?.configuration)
    const unchangedFromBase = base !== undefined
      && canonicalDigest('saki/github-synchronization-configuration/v1', configuration.data)
        === canonicalDigest('saki/github-synchronization-configuration/v1', base)
    if (pendingChangedFields.length === 0 || unchangedFromBase) {
      throw new SynchronizationConflict('configuration-unchanged')
    }
    const candidateRevision = current?.nextCandidateRevision ?? 1
    const synchronizationRevision = (current?.revision ?? 0) + 1
    const savedAt = Date.now()
    const next = githubProjectSyncRecordSchema.parse({
      id: intent.projectId,
      schemaVersion: 2,
      revision: synchronizationRevision,
      installationId: this.options.installationId,
      nextCandidateRevision: candidateRevision + 1,
      nextBoardGeneration: current?.nextBoardGeneration ?? 1,
      ...(current?.active === undefined ? {} : { active: current.active }),
      ...(current?.confirmedBoard === undefined ? {} : { confirmedBoard: current.confirmedBoard }),
      ...(current?.checkpoint === undefined ? {} : { checkpoint: current.checkpoint }),
      pending: {
        revision: candidateRevision,
        state: 'saved',
        configuration: configuration.data,
        changedFields: pendingChangedFields,
        acceptedIntentId: intent.intentId,
        receiptId: intentRecord.receiptId,
        savedAt,
      },
      nextScanAttempt: { priority: 'background', reason: 'configuration', attemptAt: savedAt },
    })
    if (current === undefined) {
      await this.options.syncTable.put(intent.projectId, next)
    } else {
      await this.options.syncTable.update(intent.projectId, (storedValue) => {
        const stored = githubProjectSyncRecordSchema.parse(storedValue)
        const storedReplay = acceptedCandidate(stored, intent.intentId)
        if (storedReplay !== undefined) return stored
        if (stored.revision !== intent.expectedSynchronizationRevision) {
          throw new SynchronizationConflict('expected-revision')
        }
        return next
      })
    }
    return { candidateRevision, synchronizationRevision }
  }

  private async recoverStartup(projectId: SakiDevelopmentProjectId, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const value = this.options.syncTable.get(projectId)
    if (value === undefined) return
    const current = githubProjectSyncRecordSchema.parse(value)
    const now = Date.now()
    if (current.inFlightAttempt !== undefined) {
      await this.completeFailure(
        current,
        current.inFlightAttempt.attemptId,
        { kind: 'attempt', reason: 'expired' },
        now,
        now,
      )
      return
    }
    if (current.pending === undefined && current.active === undefined) return
    await this.options.syncTable.update(projectId, (storedValue) => {
      const stored = githubProjectSyncRecordSchema.parse(storedValue)
      return githubProjectSyncRecordSchema.parse({
        ...stored,
        nextScanAttempt: mergeScanRequest(stored.nextScanAttempt, {
          priority: 'background',
          reason: 'startup',
          attemptAt: now,
        }),
      })
    })
  }

  private async completeFailure(
    current: GitHubProjectSyncRecord,
    attemptId: SakiGitHubScanAttemptId,
    failure: SakiGitHubScanFailure,
    failedAt: number,
    requestedRetryAt?: number,
  ): Promise<void> {
    const admittedFailure = sakiGitHubScanFailureSchema.parse(failure)
    await this.options.syncTable.update(current.id, (storedValue) => {
      const stored = githubProjectSyncRecordSchema.parse(storedValue)
      const attempt = stored.inFlightAttempt
      /* v8 ignore next -- every scan write for one Project runs behind the same operation tail. */
      if (attempt?.attemptId !== attemptId) return stored
      const configuration = currentConfiguration(stored)
      const failureRecord = currentFailure(attempt, admittedFailure, failedAt)
      const { inFlightAttempt: _inFlightAttempt, ...withoutInFlight } = stored
      return githubProjectSyncRecordSchema.parse({
        ...withoutInFlight,
        ...(stored.pending?.revision === attempt.configurationRevision ? {
          pending: { ...stored.pending, state: 'activation-failed' },
        } : {}),
        currentFailure: failureRecord,
        nextScanAttempt: mergeScanRequest(stored.nextScanAttempt, {
          priority: attempt.priority,
          reason: 'retry',
          attemptAt: requestedRetryAt ?? retryAt(failedAt, configuration, admittedFailure),
        }),
      })
    })
  }

  private requireIntent(intentId: SakiControlIntentId): GitHubSynchronizationConfigurationIntentRecord {
    const record = this.options.intentTable.get(intentId)
    if (record === undefined) throw new Error(`GitHub synchronization Intent '${intentId}' is missing`)
    return githubSynchronizationConfigurationIntentRecordSchema.parse(record)
  }

  private async transition(
    current: GitHubSynchronizationConfigurationIntentRecord,
    values: Partial<Pick<GitHubSynchronizationConfigurationIntentRecord,
      'phase' | 'candidateRevision' | 'synchronizationRevision' | 'terminalReason'>>,
  ): Promise<GitHubSynchronizationConfigurationIntentRecord> {
    return await this.options.intentTable.update(current.id, (storedValue) => {
      const stored = githubSynchronizationConfigurationIntentRecordSchema.parse(storedValue)
      if (stored.revision !== current.revision || stored.phase !== current.phase) {
        throw new Error(`GitHub synchronization Intent '${current.id}' changed during transition`)
      }
      return githubSynchronizationConfigurationIntentRecordSchema.parse({
        ...stored,
        ...values,
        revision: stored.revision + 1,
        updatedAt: Math.max(stored.updatedAt, Date.now()),
      })
    })
  }

  private enqueueProjectOperation<T>(
    projectId: SakiDevelopmentProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    return enqueueKeyedOperation(this.projectOperationTails, projectId, operation)
  }

  private enqueueIntentOperation<T>(
    intentId: SakiControlIntentId,
    operation: () => Promise<T>,
  ): Promise<T> {
    return enqueueKeyedOperation(this.intentOperationTails, intentId, operation)
  }
}

interface GitHubSynchronizationConsumerOptions {
  readonly synchronization: GitHubProjectSynchronization
  readonly github: SakiGitHub
  readonly attemptTtlMs: number
  readonly reportUnexpectedFailure: (scope: 'provider' | 'consumer') => void
}

interface FreshBoardScanWaiter {
  readonly projectId: SakiDevelopmentProjectId
  readonly excludedAttemptIds: Set<SakiGitHubScanAttemptId>
  completionBeforeFence: {
    readonly attemptId: SakiGitHubScanAttemptId
    readonly result: SakiGitHubFreshBoardScanResult
  } | undefined
  readonly signal: AbortSignal
  readonly resolve: (result: SakiGitHubFreshBoardScanResult) => void
  readonly reject: (reason: unknown) => void
  readonly abortListener: () => void
  fenceReady: boolean
  settled: boolean
}

/** Optional Provider-bound Consumer that drains durable complete-scan work in priority order. */
export class GitHubSynchronizationConsumer {
  private readonly lifetime = new AbortController()
  private readonly settled: Promise<void>
  private readonly freshBoardScanWaiters = new Map<SakiDevelopmentProjectId, Set<FreshBoardScanWaiter>>()
  private state: 'active' | 'failed' | 'disposed' = 'active'
  private activeAttempt: {
    readonly projectId: SakiDevelopmentProjectId
    readonly attemptId: SakiGitHubScanAttemptId
  } | undefined
  private waitingWake: (() => void) | undefined

  /** @param options - contained coordinator, active Provider, lease lifetime, and safe diagnostic sink. */
  constructor(private readonly options: GitHubSynchronizationConsumerOptions) {
    this.settled = this.run().catch(() => {
      if (this.state === 'active') {
        this.state = 'failed'
        this.settleAllFreshBoardScans({ state: 'unavailable', reason: 'consumer-failed' })
        this.options.reportUnexpectedFailure('consumer')
      }
    })
  }

  /** Wake the Consumer after durable scheduling state may have changed. */
  wake(): void {
    this.waitingWake?.()
  }

  /**
   * Request and await one complete Board scan admitted after this call's durable fence.
   * @param projectId - Development Project whose complete Board must be refreshed.
   * @param signal - caller cancellation; abort rejects with the signal reason.
   * @returns the new attempt's publication, safe failure, or bounded availability outcome.
   */
  async requestFreshBoardScan(
    projectId: SakiDevelopmentProjectId,
    signal: AbortSignal,
  ): Promise<SakiGitHubFreshBoardScanResult> {
    signal.throwIfAborted()
    if (this.state !== 'active') {
      return {
        state: 'unavailable',
        reason: this.state === 'failed' ? 'consumer-failed' : 'provider-detached',
      }
    }
    let resolve!: (result: SakiGitHubFreshBoardScanResult) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<SakiGitHubFreshBoardScanResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const abortListener = (): void => { this.rejectFreshBoardScan(waiter, signal.reason) }
    const waiter: FreshBoardScanWaiter = {
      projectId,
      excludedAttemptIds: new Set(
        this.activeAttempt?.projectId === projectId ? [this.activeAttempt.attemptId] : [],
      ),
      completionBeforeFence: undefined,
      signal,
      resolve,
      reject,
      abortListener,
      fenceReady: false,
      settled: false,
    }
    signal.addEventListener('abort', abortListener, { once: true })
    const projectWaiters = this.freshBoardScanWaiters.get(projectId) ?? new Set()
    projectWaiters.add(waiter)
    this.freshBoardScanWaiters.set(projectId, projectWaiters)
    void this.armFreshBoardScan(waiter, AbortSignal.any([signal, this.lifetime.signal]))
    return await promise
  }

  /** Abort an active Provider call and wait until the Consumer is quiescent. */
  async dispose(): Promise<void> {
    if (this.state !== 'disposed') {
      this.state = 'disposed'
      this.settleAllFreshBoardScans({ state: 'unavailable', reason: 'provider-detached' })
    }
    this.lifetime.abort(new Error('Saki GitHub synchronization Consumer is disposing'))
    this.wake()
    await this.settled
  }

  private async run(): Promise<void> {
    const signal = this.lifetime.signal
    while (!signal.aborted) {
      const due = this.options.synchronization.listDueScans(Date.now())[0]
      if (due === undefined) {
        await this.waitForWork(this.options.synchronization.nextScanAt())
        continue
      }
      const begun = await this.options.synchronization.beginScan(
        due.projectId,
        due.priority,
        safeTimestampAdd(Date.now(), this.options.attemptTtlMs),
        signal,
      )
      if (!begun.ok) {
        if (begun.reason !== 'in-flight') {
          this.settleProjectFreshBoardScans({
            state: 'unavailable',
            reason: begun.reason,
          }, due.projectId)
        }
        continue
      }
      this.activeAttempt = {
        projectId: due.projectId,
        attemptId: begun.lease.attemptId,
      }
      try {
        let candidate: GitHubProjectBoardScanCandidate
        try {
          candidate = await this.options.github.scan(begun.lease.request, signal)
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof GitHubProviderError) {
            const failure = { kind: 'provider', failure: error.failure } as const
            const failed = await this.options.synchronization.failScan(
              due.projectId,
              begun.lease.attemptId,
              failure,
              signal,
            )
            this.completeFreshBoardScan(due.projectId, begun.lease.attemptId, failed.state === 'failed'
              ? { state: 'failed', failure }
              : { state: 'stale' })
          } else {
            this.options.reportUnexpectedFailure('provider')
            this.completeFreshBoardScan(due.projectId, begun.lease.attemptId, {
              state: 'unavailable',
              reason: 'provider-failed',
            })
          }
          continue
        }
        signal.throwIfAborted()
        const published = await this.options.synchronization.publishScan(
          due.projectId,
          begun.lease.attemptId,
          candidate,
          signal,
        )
        this.completeFreshBoardScan(due.projectId, begun.lease.attemptId, published)
      } finally {
        this.activeAttempt = undefined
      }
    }
  }

  private async armFreshBoardScan(waiter: FreshBoardScanWaiter, signal: AbortSignal): Promise<void> {
    try {
      const requested = await this.options.synchronization.requestScanAfterCurrent(waiter.projectId, signal)
      if (requested.state === 'scheduled') this.wake()
      if (waiter.settled) return
      if (requested.state !== 'scheduled') {
        this.settleFreshBoardScan(waiter, { state: 'unavailable', reason: requested.state })
        return
      }
      if (requested.preexistingAttemptId !== undefined) {
        waiter.excludedAttemptIds.add(requested.preexistingAttemptId)
      }
      waiter.fenceReady = true
      const completion = waiter.completionBeforeFence
      waiter.completionBeforeFence = undefined
      if (completion !== undefined) {
        this.deliverFreshBoardScanCompletion(waiter, completion.attemptId, completion.result)
      }
    } catch (error) {
      if (waiter.settled) return
      this.rejectFreshBoardScan(waiter, error)
    }
  }

  private completeFreshBoardScan(
    projectId: SakiDevelopmentProjectId,
    attemptId: SakiGitHubScanAttemptId,
    result: SakiGitHubFreshBoardScanResult,
  ): void {
    for (const waiter of [...(this.freshBoardScanWaiters.get(projectId) ?? [])]) {
      this.deliverFreshBoardScanCompletion(waiter, attemptId, result)
    }
  }

  private deliverFreshBoardScanCompletion(
    waiter: FreshBoardScanWaiter,
    attemptId: SakiGitHubScanAttemptId,
    result: SakiGitHubFreshBoardScanResult,
  ): void {
    if (!waiter.fenceReady) {
      waiter.completionBeforeFence = { attemptId, result }
      return
    }
    if (!waiter.excludedAttemptIds.has(attemptId)) this.settleFreshBoardScan(waiter, result)
  }

  private settleProjectFreshBoardScans(
    result: SakiGitHubFreshBoardScanResult,
    projectId: SakiDevelopmentProjectId,
  ): void {
    for (const waiter of [...(this.freshBoardScanWaiters.get(projectId) ?? [])]) {
      this.settleFreshBoardScan(waiter, result)
    }
  }

  private settleAllFreshBoardScans(result: SakiGitHubFreshBoardScanResult): void {
    for (const waiters of this.freshBoardScanWaiters.values()) {
      for (const waiter of [...waiters]) this.settleFreshBoardScan(waiter, result)
    }
  }

  private settleFreshBoardScan(
    waiter: FreshBoardScanWaiter,
    result: SakiGitHubFreshBoardScanResult,
  ): void {
    this.removeFreshBoardScanWaiter(waiter)
    waiter.resolve(result)
  }

  private rejectFreshBoardScan(waiter: FreshBoardScanWaiter, reason: unknown): void {
    this.removeFreshBoardScanWaiter(waiter)
    waiter.reject(reason)
  }

  private removeFreshBoardScanWaiter(waiter: FreshBoardScanWaiter): void {
    waiter.settled = true
    waiter.signal.removeEventListener('abort', waiter.abortListener)
    const projectWaiters = this.freshBoardScanWaiters.get(waiter.projectId)
    projectWaiters?.delete(waiter)
    if (projectWaiters?.size === 0) this.freshBoardScanWaiters.delete(waiter.projectId)
  }

  private async waitForWork(nextScanAt: number | undefined): Promise<void> {
    const signal = this.lifetime.signal
    /* v8 ignore next -- the run loop checks this signal immediately before entering this synchronous method. */
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (): void => {
        /* v8 ignore else -- only this wait's registered wake, timer, or abort listener can call settle. */
        if (this.waitingWake === settle) this.waitingWake = undefined
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', settle)
        resolve()
      }
      this.waitingWake = settle
      signal.addEventListener('abort', settle, { once: true })
      if (nextScanAt !== undefined) {
        timer = setTimeout(settle, Math.min(Math.max(0, nextScanAt - Date.now()), MAX_TIMER_DELAY_MS))
      }
    })
  }
}

function mergeScanRequest(
  current: GitHubProjectSyncRecord['nextScanAttempt'],
  requested: NonNullable<GitHubProjectSyncRecord['nextScanAttempt']>,
): NonNullable<GitHubProjectSyncRecord['nextScanAttempt']> {
  if (current === undefined) return requested
  const priority = current.priority === 'interactive' || requested.priority === 'interactive'
    ? 'interactive'
    : 'background'
  return {
    priority,
    reason: priority === 'interactive' ? 'interactive' : (requested.attemptAt <= current.attemptAt
      ? requested.reason
      : current.reason),
    attemptAt: Math.min(current.attemptAt, requested.attemptAt),
  }
}

function priorityRank(priority: 'interactive' | 'background'): number {
  return priority === 'interactive' ? 0 : 1
}

function scanRequest(
  configuration: GitHubSynchronizationConfiguration,
  priority: 'interactive' | 'background',
) {
  return {
    kind: 'project-board' as const,
    installation: {
      appId: configuration.appId,
      installationId: configuration.githubInstallationId,
      accountId: configuration.accountNodeId,
      privateKeyRef: configuration.credentialRef,
    },
    projectId: configuration.projectNodeId,
    repositoryId: configuration.repositoryNodeId,
    repositoryDatabaseId: configuration.repositoryDatabaseId,
    statusFieldId: configuration.statusFieldNodeId,
    requiredStatusOptionIds: STATUS_MAPPING_FIELDS.map(([field]) => configuration.statusOptionNodeIds[field]),
    priority,
    rateLimitReserve: configuration.rateLimitReserve,
  }
}

function currentFailure(
  attempt: NonNullable<GitHubProjectSyncRecord['inFlightAttempt']>,
  failure: SakiGitHubScanFailure,
  failedAt: number,
): NonNullable<GitHubProjectSyncRecord['currentFailure']> {
  return {
    attemptId: attempt.attemptId,
    configurationRevision: attempt.configurationRevision,
    failedAt,
    failure,
  }
}

function currentConfiguration(record: GitHubProjectSyncRecord): GitHubSynchronizationConfiguration {
  const configuration = record.pending?.configuration ?? record.active?.configuration
  /* v8 ignore next -- callers hold an in-flight or projected revision that the durable schema ties to a configuration. */
  if (configuration === undefined) throw new Error(`GitHub Project sync '${record.id}' has no current configuration`)
  return configuration
}

function candidateTargetsConfiguration(
  candidate: GitHubProjectBoardScanCandidate,
  configuration: GitHubSynchronizationConfiguration,
): boolean {
  return candidate.installation.installationId === configuration.githubInstallationId
    && candidate.installation.account.id === configuration.accountNodeId
    && candidate.repository.id === configuration.repositoryNodeId
    && candidate.repository.databaseId === configuration.repositoryDatabaseId
    && candidate.project.id === configuration.projectNodeId
    && candidate.statusFieldId === configuration.statusFieldNodeId
}

function hasDuplicateConfiguredRepositoryIssue(
  candidate: GitHubProjectBoardScanCandidate,
  configuration: GitHubSynchronizationConfiguration,
): boolean {
  const issueIds = candidate.items.flatMap((item) => {
    if (item.content.kind !== 'issue'
      || item.content.issue.repositoryId !== configuration.repositoryNodeId
      || item.content.issue.repositoryDatabaseId !== configuration.repositoryDatabaseId) return []
    return [item.content.issue.id]
  })
  return new Set(issueIds).size !== issueIds.length
}

function boardWorkItemCount(
  candidate: GitHubProjectBoardScanCandidate,
  configuration: GitHubSynchronizationConfiguration,
): number {
  const joinedIssueIds = new Set(candidate.items.flatMap((item) => {
    if (item.content.kind !== 'issue'
      || item.content.issue.repositoryId !== configuration.repositoryNodeId
      || item.content.issue.repositoryDatabaseId !== configuration.repositoryDatabaseId) return []
    return [item.content.issue.id]
  }))
  return joinedIssueIds.size + candidate.openIssues.filter(issue => !joinedIssueIds.has(issue.id)).length
}

function normalizeScanFailure(
  failure: SakiGitHubScanFailure,
  configuration: GitHubSynchronizationConfiguration,
): SakiGitHubScanFailure {
  if (failure.kind !== 'provider' || failure.failure.code !== 'mapping-mismatch') return failure
  const mismatch = failure.failure
  if (mismatch.statusFieldId !== configuration.statusFieldNodeId) {
    return { kind: 'candidate', reason: 'invalid-candidate' }
  }
  if (mismatch.reason === 'field-missing-or-not-single-select') return failure
  const configuredOptionIds = new Set(Object.values(configuration.statusOptionNodeIds))
  return mismatch.missingRequiredStatusOptionIds.every(optionId => configuredOptionIds.has(optionId))
    ? failure
    : { kind: 'candidate', reason: 'invalid-candidate' }
}

function mapBoardCandidate(
  candidate: GitHubProjectBoardScanCandidate,
  configuration: GitHubSynchronizationConfiguration,
  generation: number,
  configurationRevision: number,
  previousBoard: SakiConfirmedBoardProjection | undefined,
  recoveredNonTerminalStatus: (
    workItemId: SakiBoardWorkItemId,
  ) => Exclude<SakiBoardStatus, 'done' | 'canceled'> | null | undefined,
):
  | { readonly ok: true; readonly board: NonNullable<GitHubProjectSyncRecord['confirmedBoard']> }
  | { readonly ok: false; readonly issues: readonly SakiGitHubMappingIssue[] } {
  const issues: SakiGitHubMappingIssue[] = []
  const statusField = candidate.fields.find(
    (field): field is Extract<GitHubProjectFieldFact, { readonly kind: 'single-select' }> => (
      field.id === configuration.statusFieldNodeId && field.kind === 'single-select'
    ),
  )
  /* v8 ignore next -- candidate admission requires statusFieldId to identify one single-select field. */
  if (statusField === undefined) throw new Error('admitted GitHub candidate lost its Status field')
  const availableOptionIds = new Set(statusField.options.map(option => option.id))
  const statusByOptionId = new Map<GitHubProjectOptionId, SakiBoardStatus>()
  for (const [field, status] of STATUS_MAPPING_FIELDS) {
    const optionId = configuration.statusOptionNodeIds[field]
    statusByOptionId.set(optionId, status)
    if (!availableOptionIds.has(optionId)) {
      issues.push({ reason: 'status-option-missing', status, statusOptionId: optionId })
    }
  }

  const joined: Array<{
    readonly item: GitHubProjectItemFact
    readonly issue: Extract<GitHubProjectItemFact['content'], { readonly kind: 'issue' }>['issue']
    readonly status: SakiBoardStatus
  }> = []
  for (const item of candidate.items) {
    if (item.content.kind !== 'issue') continue
    const issue = item.content.issue
    if (issue.repositoryId !== configuration.repositoryNodeId
      || issue.repositoryDatabaseId !== configuration.repositoryDatabaseId) continue
    if (item.archived) {
      joined.push({ item, issue, status: 'canceled' })
      continue
    }
    if (item.statusOptionId === undefined) {
      issues.push({ reason: 'work-item-status-missing', issueId: issue.id })
      continue
    }
    const status = statusByOptionId.get(item.statusOptionId)
    if (status === undefined) {
      issues.push({
        reason: 'work-item-status-unknown',
        issueId: issue.id,
        statusOptionId: item.statusOptionId,
      })
      continue
    }
    joined.push({ item, issue, status })
  }
  if (issues.length > 0) {
    return { ok: false, issues: uniqueMappingIssues(issues) }
  }

  const previousItems = previousBoard?.repository.id === candidate.repository.id
    && previousBoard.project.id === candidate.project.id
    ? new Map(previousBoard.items.map(item => [item.id, item] as const))
    : new Map<SakiBoardWorkItemId, SakiConfirmedBoardProjection['items'][number]>()
  const latestNonTerminalStatus = (
    id: ReturnType<typeof boardWorkItemId>,
    status: SakiBoardStatus,
  ): Exclude<SakiBoardStatus, 'done' | 'canceled'> | null => {
    if (status !== 'done' && status !== 'canceled') return status
    const recovered = recoveredNonTerminalStatus(id)
    return recovered === undefined ? previousItems.get(id)?.latestNonTerminalStatus ?? null : recovered
  }
  const joinedIssueIds = new Set(joined.map(value => value.issue.id))
  const joinedItems = joined.map(({ item, issue, status }) => {
    const id = boardWorkItemId(issue.repositoryId, issue.id)
    return {
      id,
      title: issue.title,
      issueNumber: issue.number,
      url: issue.url,
      issueState: issue.state,
      status,
      latestNonTerminalStatus: latestNonTerminalStatus(id, status),
      order: item.apiOrder,
      archived: item.archived,
      notInProject: false,
      updatedAt: Math.max(issue.updatedAt, item.updatedAt),
      source: {
        kind: 'github-issue' as const,
        repositoryId: issue.repositoryId,
        issueId: issue.id,
        projectItemId: item.id,
        apiOrder: item.apiOrder,
      },
      remoteFingerprint: joinedBoardRemoteFingerprint(candidate.items, item, issue.state),
    }
  })
  const unjoinedItems = candidate.openIssues
    .filter(issue => !joinedIssueIds.has(issue.id))
    .map((issue, index) => ({
      id: boardWorkItemId(issue.repositoryId, issue.id),
      title: issue.title,
      issueNumber: issue.number,
      url: issue.url,
      issueState: issue.state,
      status: 'inbox' as const,
      latestNonTerminalStatus: 'inbox' as const,
      order: candidate.items.length + index,
      archived: false,
      notInProject: true,
      updatedAt: issue.updatedAt,
      source: {
        kind: 'github-issue' as const,
        repositoryId: issue.repositoryId,
        issueId: issue.id,
      },
      remoteFingerprint: unjoinedBoardRemoteFingerprint(issue.repositoryId, issue.id, issue.state),
    }))
  return {
    ok: true,
    board: {
      generation,
      configurationRevision,
      repository: {
        id: candidate.repository.id,
        nameWithOwner: candidate.repository.nameWithOwner,
        url: candidate.repository.url,
      },
      project: {
        id: candidate.project.id,
        title: candidate.project.title,
        url: candidate.project.url,
      },
      items: [...joinedItems, ...unjoinedItems],
    },
  }
}

function uniqueMappingIssues(issues: readonly SakiGitHubMappingIssue[]): readonly SakiGitHubMappingIssue[] {
  return [...new Map(issues.map(issue => [JSON.stringify(issue), issue] as const)).values()]
}

function summarizeRateLimit(observations: readonly GitHubRateObservation[]): SakiGitHubRateLimitProjection {
  if (observations.length === 0) return { state: 'unobserved' }
  const limited = observations.filter(observation => observation.kind === 'secondary-limit'
    || observation.remaining === 0
    || (observation.kind === 'rest' && observation.retryAfterMs !== undefined))
  if (limited.length > 0) {
    const observedAt = Math.max(...limited.map(observation => observation.observedAt))
    const resets = limited.flatMap((observation) => {
      if (observation.kind === 'secondary-limit') {
        return observation.retryAfterMs === undefined
          ? []
          : [safeTimestampAdd(observation.observedAt, observation.retryAfterMs)]
      }
      if (observation.kind === 'rest' && observation.retryAfterMs !== undefined) {
        const retryAt = safeTimestampAdd(observation.observedAt, observation.retryAfterMs)
        return observation.remaining === 0 ? [observation.resetAt, retryAt] : [retryAt]
      }
      return [observation.resetAt]
    })
    return {
      state: 'limited',
      observedAt,
      ...(resets.length === 0 ? {} : { resetAt: Math.max(...resets) }),
    }
  }
  const primary = observations.filter(observation => observation.kind !== 'secondary-limit')
  const minimumRemaining = Math.min(...primary.map(observation => observation.remaining))
  const minimumObservations = primary.filter(observation => observation.remaining === minimumRemaining)
  return {
    state: 'available',
    observedAt: Math.max(...minimumObservations.map(observation => observation.observedAt)),
    minimumRemaining,
    resetAt: Math.max(...minimumObservations.map(observation => observation.resetAt)),
  }
}

function nextSuccessfulPollAt(
  now: number,
  configuration: GitHubSynchronizationConfiguration,
  rateLimit: SakiGitHubRateLimitProjection,
): number {
  const intervalAt = safeTimestampAdd(now, configuration.backgroundPollIntervalMs)
  if (rateLimit.state === 'limited' && rateLimit.resetAt !== undefined) {
    return Math.max(intervalAt, rateLimit.resetAt)
  }
  if (rateLimit.state === 'available' && rateLimit.minimumRemaining <= configuration.rateLimitReserve) {
    return Math.max(intervalAt, rateLimit.resetAt)
  }
  return intervalAt
}

function retryAt(
  failedAt: number,
  configuration: GitHubSynchronizationConfiguration,
  failure: SakiGitHubScanFailure,
): number {
  let next = safeTimestampAdd(failedAt, configuration.backgroundPollIntervalMs)
  if (failure.kind !== 'provider') return next
  if (failure.failure.code === 'primary-rate-limit' && failure.failure.resetAt !== undefined) {
    next = Math.max(next, failure.failure.resetAt)
  }
  if ((failure.failure.code === 'secondary-rate-limit' || failure.failure.code === 'transient-transport')
    && failure.failure.retryAfterMs !== undefined) {
    next = Math.max(next, safeTimestampAdd(failedAt, failure.failure.retryAfterMs))
  }
  return next
}

function safeTimestampAdd(timestamp: number, duration: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, timestamp + duration)
}

function boardProjection(
  projectId: SakiDevelopmentProjectId,
  value: GitHubProjectSyncRecord | undefined,
  now: number,
): SakiBoardProjection {
  const record = value === undefined ? undefined : githubProjectSyncRecordSchema.parse(value)
  const {
    revision: _revision,
    state: _synchronizationState,
    ...common
  } = synchronizationProjection(record, now)
  const configured = record?.pending !== undefined || record?.active !== undefined
  return {
    type: 'board',
    projectId,
    state: !configured
      ? 'unconfigured'
      : (record.confirmedBoard === undefined ? 'awaiting-first-checkpoint' : 'confirmed'),
    synchronizationRevision: record?.revision ?? 0,
    ...(record?.confirmedBoard === undefined ? {} : { confirmed: record.confirmedBoard }),
    ...common,
    mutationOverlays: [],
  }
}

function synchronizationProjection(
  record: GitHubProjectSyncRecord | undefined,
  now: number,
): Pick<SakiBoardProjection,
  | 'checkpoint'
  | 'mapping'
  | 'failure'
  | 'freshness'
  | 'scan'
  | 'effectiveMutationAvailability'> & {
    readonly revision: number
    readonly state: SakiProjectSettingsProjection['synchronization']['state']
  } {
  const mapping = mappingHealth(record)
  const freshness = boardFreshness(record, now)
  return {
    revision: record?.revision ?? 0,
    state: record?.pending?.state ?? (record?.active === undefined ? 'unconfigured' : 'activated'),
    ...(record?.checkpoint === undefined ? {} : { checkpoint: record.checkpoint }),
    mapping,
    ...(record?.currentFailure === undefined ? {} : {
      failure: projectSynchronizationFailure(record.currentFailure),
    }),
    freshness,
    scan: scanState(record),
    effectiveMutationAvailability: mutationAvailability(record, mapping),
  }
}

function projectSynchronizationFailure(
  current: NonNullable<GitHubProjectSyncRecord['currentFailure']>,
): SakiGitHubSynchronizationFailureProjection {
  return {
    attemptId: current.attemptId,
    configurationRevision: current.configurationRevision,
    failedAt: current.failedAt,
    failure: current.failure.kind === 'provider'
      ? { kind: 'provider', failure: projectGitHubFailure(current.failure.failure) }
      : structuredClone(current.failure),
  }
}

function mappingHealth(record: GitHubProjectSyncRecord | undefined): SakiGitHubMappingHealthProjection {
  if (record === undefined) return { state: 'unconfigured' }
  const configurationRevision = record.pending?.revision ?? record.active?.revision
  if (configurationRevision === undefined) return { state: 'unconfigured' }
  const configuration = currentConfiguration(record)
  const issues = failureMappingIssues(record.currentFailure, configuration)
  if (issues.length > 0) return { state: 'repair-required', configurationRevision, issues }
  if (record.pending !== undefined || record.checkpoint?.configurationRevision !== configurationRevision) {
    return { state: 'revalidation-required', configurationRevision }
  }
  return {
    state: 'valid',
    configurationRevision,
    validatedAt: record.checkpoint.confirmedAt,
  }
}

function failureMappingIssues(
  current: GitHubProjectSyncRecord['currentFailure'],
  configuration: GitHubSynchronizationConfiguration,
): readonly SakiGitHubMappingIssue[] {
  if (current === undefined) return []
  if (current.failure.kind === 'mapping') return current.failure.issues
  if (current.failure.kind !== 'provider' || current.failure.failure.code !== 'mapping-mismatch') return []
  const failure = current.failure.failure
  if (failure.reason === 'field-missing-or-not-single-select') {
    return [{ reason: 'status-field-missing', statusFieldId: failure.statusFieldId }]
  }
  const statusByOptionId = new Map(STATUS_MAPPING_FIELDS.map(([field, status]) => [
    configuration.statusOptionNodeIds[field],
    status,
  ] as const))
  return failure.missingRequiredStatusOptionIds.map((statusOptionId) => {
    const status = statusByOptionId.get(statusOptionId)
    /* v8 ignore next -- durable validation restricts mapping failures to configured Status options. */
    if (status === undefined) throw new Error('retained GitHub mapping failure names an unknown Status option')
    return { reason: 'status-option-missing' as const, status, statusOptionId }
  })
}

function boardFreshness(
  record: GitHubProjectSyncRecord | undefined,
  now: number,
) {
  if (record?.checkpoint === undefined || record.active === undefined) return { state: 'unavailable' as const }
  const confirmedAt = record.checkpoint.confirmedAt
  const staleAt = safeTimestampAdd(confirmedAt, record.active.configuration.activePollIntervalMs)
  return {
    state: now >= staleAt ? 'stale' as const : 'fresh' as const,
    confirmedAt,
    staleAt,
    ageMs: Math.max(0, now - confirmedAt),
  }
}

function scanState(record: GitHubProjectSyncRecord | undefined): SakiGitHubScanStateProjection {
  if (record?.inFlightAttempt !== undefined) return { state: 'in-flight', ...record.inFlightAttempt }
  if (record?.nextScanAttempt !== undefined) return { state: 'scheduled', ...record.nextScanAttempt }
  return { state: 'idle' }
}

function mutationUnavailableReasons(
  record: GitHubProjectSyncRecord | undefined,
  mapping: SakiGitHubMappingHealthProjection,
): readonly SakiBoardMutationUnavailableReason[] {
  const reasons: SakiBoardMutationUnavailableReason[] = []
  if (record === undefined || (record.active === undefined && record.pending === undefined)) {
    reasons.push('synchronization-unconfigured')
  } else if (record.active === undefined || record.pending !== undefined) {
    reasons.push('configuration-not-activated')
  }
  if (mapping.state === 'revalidation-required') reasons.push('mapping-revalidation-required')
  if (mapping.state === 'repair-required') reasons.push('mapping-repair-required')
  if (record?.checkpoint === undefined) reasons.push('checkpoint-unavailable')
  return reasons
}

function mutationAvailability(
  record: GitHubProjectSyncRecord | undefined,
  mapping: SakiGitHubMappingHealthProjection,
): SakiBoardProjection['effectiveMutationAvailability'] {
  const reasons = mutationUnavailableReasons(record, mapping)
  return reasons.length === 0
    ? { available: true, reasons: [] }
    : { available: false, reasons }
}

/**
 * Parse and cross-check one complete GitHub synchronization record collection without effects.
 * @param syncTable - read-only per-Project synchronization aggregate table.
 * @param intentTable - read-only configuration Intent table.
 * @param installationId - Installation that owns every record.
 * @param projectExists - authoritative Development Project membership test.
 * @param validateActorReference - Foundation reference validator for retained Intent authority.
 * @returns detached records suitable for deterministic recovery.
 */
export function validateGitHubSynchronizationDurableState(
  syncTable: Pick<GitHubProjectSyncTable, 'entries'>,
  intentTable: Pick<GitHubSynchronizationConfigurationIntentTable, 'entries'>,
  installationId: RegistrationActor['installationId'],
  projectExists: (projectId: SakiDevelopmentProjectId) => boolean,
  validateActorReference: (actor: RegistrationActor) => void,
): ValidatedGitHubSynchronizationState {
  const syncRecords = [...syncTable.entries()].map(([key, value]) => {
    const record = githubProjectSyncRecordSchema.parse(value)
    if (record.id !== key) throw new Error(`GitHub Project sync '${key}' disagrees with its table key`)
    if (record.installationId !== installationId) {
      throw new Error(`GitHub Project sync '${key}' belongs to another Installation`)
    }
    if (!projectExists(record.id)) {
      throw new Error(`GitHub Project sync '${key}' has no Development Project`)
    }
    return record
  })
  const intents = [...intentTable.entries()].map(([key, value]) => {
    const record = githubSynchronizationConfigurationIntentRecordSchema.parse(value)
    if (record.id !== key) throw new Error(`GitHub synchronization Intent '${key}' disagrees with its table key`)
    if (record.payload.actor.installationId !== installationId) {
      throw new Error(`GitHub synchronization Intent '${key}' belongs to another Installation`)
    }
    validateActorReference(record.payload.actor)
    if (record.phase !== 'conflict' || record.terminalReason !== 'project-not-found') {
      if (!projectExists(record.payload.intent.projectId)) {
        throw new Error(`GitHub synchronization Intent '${key}' has no Development Project`)
      }
    }
    return record
  })
  validateCommittedIntentMappings(syncRecords, intents)
  return { syncRecords, intents }
}

function changedFields(
  candidate: GitHubSynchronizationConfiguration,
  active: GitHubSynchronizationConfiguration | undefined,
): GitHubSynchronizationConfigurationField[] {
  return CONFIGURATION_FIELDS.filter(field => active === undefined
    || canonicalDigest('saki/github-synchronization-field/v1', candidate[field])
      !== canonicalDigest('saki/github-synchronization-field/v1', active[field]))
}

function acceptedCandidate(
  record: GitHubProjectSyncRecord,
  intentId: SakiControlIntentId,
): { readonly candidateRevision: number; readonly synchronizationRevision: number } | undefined {
  const pending = record.pending
  if (pending?.acceptedIntentId === intentId) {
    return { candidateRevision: pending.revision, synchronizationRevision: record.revision }
  }
  const active = record.active
  if (active?.acceptedIntentId === intentId) {
    return { candidateRevision: active.revision, synchronizationRevision: record.revision }
  }
  return undefined
}

function sameIncomingIntent(
  record: GitHubSynchronizationConfigurationIntentRecord,
  intent: ConfigureGitHubSynchronizationIntent,
): boolean {
  return canonicalDigest('saki/configure-github-synchronization/v1', {
    intent,
    actor: record.payload.actor,
  }) === record.payloadDigest
}

function receiptFor(
  record: GitHubSynchronizationConfigurationIntentRecord,
): SakiIntentReceipt<'configure-github-synchronization'> {
  const base = { id: record.receiptId, intentId: record.id }
  if (record.phase === 'saved') {
    return {
      ok: true,
      receipt: {
        ...base,
        state: 'saved',
        projectId: record.payload.intent.projectId,
        candidateRevision: record.candidateRevision as number,
        synchronizationRevision: record.synchronizationRevision as number,
      },
    }
  }
  if (record.phase === 'conflict') {
    return {
      ok: false,
      reason: 'conflict',
      receipt: {
        ...base,
        state: 'conflict',
        reason: record.terminalReason as SynchronizationConflict['reason'],
      },
    }
  }
  /* v8 ignore else -- resume settles prepared records before requesting a receipt. */
  if (record.phase === 'failure') {
    return { ok: false, reason: 'failure', receipt: { ...base, state: 'failure', reason: 'authority' } }
  }
  /* v8 ignore next -- resume settles prepared records before requesting a receipt. */
  return { ok: false, reason: 'unavailable', receipt: { ...base, state: 'prepared' } }
}

function receiptId(intentId: SakiControlIntentId): SakiIntentReceiptId {
  return intentId.replace(/^intent-/u, 'receipt-') as SakiIntentReceiptId
}

function validateCommittedIntentMappings(
  syncRecords: readonly GitHubProjectSyncRecord[],
  intents: readonly GitHubSynchronizationConfigurationIntentRecord[],
): void {
  const syncByProject = new Map(syncRecords.map(record => [record.id, record] as const))
  const preparedProjects = new Set<SakiDevelopmentProjectId>()
  for (const intent of intents) {
    if (intent.phase === 'prepared') {
      const projectId = intent.payload.intent.projectId
      if (preparedProjects.has(projectId)) {
        throw new Error(`GitHub Project sync '${projectId}' retains multiple prepared Intents`)
      }
      preparedProjects.add(projectId)
    }
    if (intent.phase !== 'saved') continue
    const sync = syncByProject.get(intent.payload.intent.projectId)
    if (sync === undefined
      || (intent.candidateRevision as number) >= sync.nextCandidateRevision
      || (intent.synchronizationRevision as number) > sync.revision) {
      throw new Error(`saved GitHub synchronization Intent '${intent.id}' has no aggregate mapping`)
    }
  }
  for (const sync of syncRecords) {
    const projectIntents = intents.filter(intent => intent.payload.intent.projectId === sync.id)
    const saved = projectIntents
      .filter(intent => intent.phase === 'saved')
      .sort((left, right) => (left.candidateRevision as number) - (right.candidateRevision as number))
    const accepted = [sync.active, sync.pending].filter(candidate => candidate !== undefined)
    if (new Set(accepted.map(candidate => candidate.acceptedIntentId)).size !== accepted.length) {
      throw new Error(`GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
    }
    const mappedPrepared = accepted.flatMap((candidate) => {
      const intent = projectIntents.find(value => value.id === candidate.acceptedIntentId)
      return intent?.phase === 'prepared' ? [{ candidate, intent }] : []
    })
    const preparedCommit = mappedPrepared[0]
    const expectedSavedRevisions = sync.revision - (preparedCommit === undefined ? 0 : 1)
    const completeRevisionHistory = expectedSavedRevisions >= 0
      && saved.length === expectedSavedRevisions
      && sync.nextCandidateRevision - 1 === sync.revision
      && saved.every((intent, index) => intent.candidateRevision === index + 1
        && intent.synchronizationRevision === index + 1
        && intent.payload.intent.expectedSynchronizationRevision === index)
    if (!completeRevisionHistory) {
      throw new Error(`GitHub Project sync '${sync.id}' has invalid saved Intent revisions`)
    }
    if (preparedCommit !== undefined
      && (preparedCommit.candidate.revision !== sync.revision
        || preparedCommit.intent.payload.intent.expectedSynchronizationRevision !== sync.revision - 1)) {
      throw new Error(`GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
    }

    const commits: Array<{
      readonly intent: GitHubSynchronizationConfigurationIntentRecord
      readonly candidateRevision: number
      readonly synchronizationRevision: number
    }> = saved.map(intent => ({
      intent,
      candidateRevision: intent.candidateRevision as number,
      synchronizationRevision: intent.synchronizationRevision as number,
    }))
    if (preparedCommit !== undefined) {
      commits.push({
        intent: preparedCommit.intent,
        candidateRevision: preparedCommit.candidate.revision,
        synchronizationRevision: sync.revision,
      })
    }
    let priorConfiguration: GitHubSynchronizationConfiguration | undefined
    for (const commit of commits) {
      const resolved = githubSynchronizationConfigurationSchema.safeParse({
        ...priorConfiguration,
        ...commit.intent.payload.intent.patch,
      })
      if (!resolved.success) {
        throw new Error(`GitHub Project sync '${sync.id}' has invalid saved Intent revisions`)
      }
      const candidate = accepted.find(value => value.acceptedIntentId === commit.intent.id)
      if (candidate !== undefined
        && (candidate.receiptId !== commit.intent.receiptId
          || candidate.revision !== commit.candidateRevision
          || canonicalDigest('saki/github-synchronization-configuration/v1', candidate.configuration)
            !== canonicalDigest('saki/github-synchronization-configuration/v1', resolved.data))) {
        throw new Error(`GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
      }
      priorConfiguration = resolved.data
    }
    for (const candidate of accepted) {
      const intent = projectIntents.find(value => value.id === candidate.acceptedIntentId)
      const permittedPhase = intent?.phase === 'saved'
        || (intent?.phase === 'prepared' && preparedCommit?.intent.id === intent.id)
      if (!permittedPhase || intent.receiptId !== candidate.receiptId
        || (intent.phase === 'saved'
          && (intent.candidateRevision !== candidate.revision
            || intent.synchronizationRevision !== candidate.revision))) {
        throw new Error(`GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
      }
    }
    if (sync.pending !== undefined) {
      const expectedChangedFields = changedFields(sync.pending.configuration, sync.active?.configuration)
      if (canonicalDigest('saki/github-synchronization-changed-fields/v1', sync.pending.changedFields)
        !== canonicalDigest('saki/github-synchronization-changed-fields/v1', expectedChangedFields)) {
        throw new Error(`GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
      }
    }
  }
}
