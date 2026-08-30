/** Frozen GitHub durable schemas for the exact Saki control-plane v4 migration source. */

import { z } from 'zod'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { v4CanonicalDigest } from './migration-v4-canonical.ts'
import { v4Source } from './migration-v4-source.ts'
import type { SakiGitHubScanFailure } from './types.ts'

const {
  V4_SAKI_BOARD_WORK_ITEM_LIMIT: SAKI_BOARD_WORK_ITEM_LIMIT,
  V4_SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT: SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
  V4_SAKI_GITHUB_MAPPING_ISSUE_LIMIT: SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
  v4BoardRemoteFingerprintSchema: boardRemoteFingerprint,
  v4BoardWorkItemIdSchema: boardWorkItemId,
  v4ControlIntentIdSchema: controlIntentId,
  v4DevelopmentProjectIdSchema: developmentProjectId,
  v4GitHubAccountIdSchema: githubAccountIdSchema,
  v4GitHubAppIdSchema: githubAppIdSchema,
  v4GitHubFailureSchema: githubFailureSchema,
  v4GitHubInstallationIdSchema: githubInstallationIdSchema,
  v4GitHubIssueIdSchema: githubIssueIdSchema,
  v4GitHubProjectBoardFingerprintSchema: githubProjectBoardFingerprintSchema,
  v4GitHubProjectFieldIdSchema: githubProjectFieldIdSchema,
  v4GitHubProjectIdSchema: githubProjectIdSchema,
  v4GitHubProjectItemIdSchema: githubProjectItemIdSchema,
  v4GitHubProjectOptionIdSchema: githubProjectOptionIdSchema,
  v4GitHubRepositoryDatabaseIdSchema: githubRepositoryDatabaseIdSchema,
  v4GitHubRepositoryIdSchema: githubRepositoryIdSchema,
  v4GitHubScanAttemptIdSchema: githubScanAttemptId,
  v4InstallationIdSchema: installationId,
  v4IntentReceiptIdSchema: intentReceiptId,
  v4RegistrationActorSchema: registrationActorSchema,
} = v4Source

/* Historical v4 schemas are frozen migration inputs and cannot import mutable current-schema definitions. */
/* jscpd:ignore-start */
const revision = z.number().int().nonnegative()
const positiveRevision = z.number().int().positive()
const timestamp = z.number().int().nonnegative()
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const githubSafeText = z.string().min(1).max(4_096).regex(/^[^\u0000\u007f]*$/u)
const githubNameWithOwner = z.string().regex(/^[^/\u0000-\u001f\u007f]+\/[^/\u0000-\u001f\u007f]+$/u).max(201)
const githubSafeUrl = z.url().max(2_048).refine((value) => {
  const parsed = new URL(value)
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hash === ''
}, 'URL must be credential-free HTTPS without a fragment')

function boundedArrayPreflight(maximum: number, maximumMessage: string) {
  return z.custom<unknown[]>(value => Array.isArray(value) && value.length <= maximum, {
    message: maximumMessage,
  })
}

function refineDurableIntentIdentity(
  value: { readonly id: string; readonly receiptId: string; readonly payload: { readonly intent: { readonly intentId: string } } },
  context: z.RefinementCtx,
): void {
  if (value.id !== value.payload.intent.intentId) context.addIssue({ code: 'custom', message: 'Intent id disagrees with immutable payload' })
  if (value.receiptId !== value.id.replace(/^intent-/u, 'receipt-')) context.addIssue({ code: 'custom', message: 'receipt id disagrees with Intent id' })
}

const credentialRef = z.string().min(1).max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .transform(value => value as CredentialRef)
const pollInterval = z.number().int().min(1_000).max(86_400_000)
const rateLimitReserve = z.number().int().nonnegative().max(5_000)

/** Exact persisted mapping from the seven Saki statuses to GitHub option node ids. */
export const githubStatusOptionMappingSchema = z.object({
  inbox: githubProjectOptionIdSchema,
  backlog: githubProjectOptionIdSchema,
  ready: githubProjectOptionIdSchema,
  inProgress: githubProjectOptionIdSchema,
  inReview: githubProjectOptionIdSchema,
  done: githubProjectOptionIdSchema,
  canceled: githubProjectOptionIdSchema,
}).strict().superRefine((value, context) => {
  const optionIds = Object.values(value)
  if (new Set(optionIds).size !== optionIds.length) {
    context.addIssue({ code: 'custom', message: 'GitHub Status option ids must be distinct' })
  }
})

const githubSynchronizationConfigurationShape = {
  appId: githubAppIdSchema,
  githubInstallationId: githubInstallationIdSchema,
  accountNodeId: githubAccountIdSchema,
  repositoryNodeId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  projectNodeId: githubProjectIdSchema,
  credentialRef,
  statusFieldNodeId: githubProjectFieldIdSchema,
  statusOptionNodeIds: githubStatusOptionMappingSchema,
  activePollIntervalMs: pollInterval,
  backgroundPollIntervalMs: pollInterval,
  rateLimitReserve,
} as const

/** Complete safe GitHub synchronization configuration stored by the control plane. */
export const githubSynchronizationConfigurationSchema = z.object(
  githubSynchronizationConfigurationShape,
).strict()

/** Non-empty field-scoped configuration patch accepted from the browser-facing Intent seam. */
export const githubSynchronizationConfigurationPatchSchema = z.object(
  githubSynchronizationConfigurationShape,
).partial().strict().refine(value => Object.keys(value).length > 0, 'configuration patch must change at least one field')

/** Strict field-scoped GitHub synchronization configuration Intent. */
export const configureGitHubSynchronizationIntentSchema = z.object({
  type: z.literal('configure-github-synchronization'),
  intentId: controlIntentId,
  projectId: developmentProjectId,
  expectedSynchronizationRevision: revision,
  patch: githubSynchronizationConfigurationPatchSchema,
}).strict()

const synchronizationConfigurationField = z.enum([
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
])

const githubSynchronizationCandidateSchema = z.object({
  revision: positiveRevision,
  state: z.enum(['saved', 'activating', 'activation-failed']),
  configuration: githubSynchronizationConfigurationSchema,
  changedFields: z.array(synchronizationConfigurationField).min(1),
  acceptedIntentId: controlIntentId,
  receiptId: intentReceiptId,
  savedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (new Set(value.changedFields).size !== value.changedFields.length) {
    context.addIssue({ code: 'custom', message: 'pending configuration repeats changed fields' })
  }
})

const activeGitHubSynchronizationConfigurationSchema = z.object({
  revision: positiveRevision,
  configuration: githubSynchronizationConfigurationSchema,
  acceptedIntentId: controlIntentId,
  receiptId: intentReceiptId,
  activatedAt: timestamp,
}).strict()

const boardStatusSchema = z.enum([
  'inbox',
  'backlog',
  'ready',
  'in-progress',
  'in-review',
  'done',
  'canceled',
])

/** Strict attributed GitHub mapping defect retained without display-name guessing. */
export const sakiGitHubMappingIssueSchema = z.discriminatedUnion('reason', [
  z.object({
    reason: z.literal('status-field-missing'),
    statusFieldId: githubProjectFieldIdSchema,
  }).strict(),
  z.object({
    reason: z.literal('status-option-missing'),
    status: boardStatusSchema,
    statusOptionId: githubProjectOptionIdSchema,
  }).strict(),
  z.object({
    reason: z.literal('work-item-status-missing'),
    issueId: githubIssueIdSchema,
  }).strict(),
  z.object({
    reason: z.literal('work-item-status-unknown'),
    issueId: githubIssueIdSchema,
    statusOptionId: githubProjectOptionIdSchema,
  }).strict(),
])

const sakiGitHubMappingIssueListSchema = boundedArrayPreflight(
  SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
  'GitHub mapping failure exceeds the mapping issue limit',
).pipe(z.array(sakiGitHubMappingIssueSchema).min(1))
  .superRefine((issues, context) => {
    const fieldIssues = issues.filter(issue => issue.reason === 'status-field-missing')
    if (fieldIssues.length > 0 && issues.length !== 1) {
      context.addIssue({ code: 'custom', message: 'missing Status field must be the only mapping issue' })
    }

    const itemIssues = issues.filter(issue => issue.reason === 'work-item-status-missing'
      || issue.reason === 'work-item-status-unknown')
    if (itemIssues.length > SAKI_BOARD_WORK_ITEM_LIMIT) {
      context.addIssue({ code: 'custom', message: 'GitHub mapping failure exceeds the Board Work Item limit' })
    }
    const issueIds = itemIssues.map(issue => issue.issueId)
    if (new Set(issueIds).size !== issueIds.length) {
      context.addIssue({ code: 'custom', message: 'GitHub mapping failure repeats a Work Item Issue identity' })
    }

    const optionIssues = issues.filter(issue => issue.reason === 'status-option-missing')
    if (optionIssues.length > boardStatusSchema.options.length) {
      context.addIssue({ code: 'custom', message: 'GitHub mapping failure exceeds the Saki status count' })
    }
    const statuses = optionIssues.map(issue => issue.status)
    if (new Set(statuses).size !== statuses.length) {
      context.addIssue({ code: 'custom', message: 'GitHub mapping failure repeats a Saki status' })
    }
    const optionIds = optionIssues.map(issue => issue.statusOptionId)
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({ code: 'custom', message: 'GitHub mapping failure repeats a Status option id' })
    }
  })
/** Strict safe failure retained for one complete scan attempt. */
export const sakiGitHubScanFailureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('provider'), failure: githubFailureSchema }).strict(),
  z.object({
    kind: z.literal('mapping'),
    issues: sakiGitHubMappingIssueListSchema,
  }).strict(),
  z.object({
    kind: z.literal('candidate'),
    reason: z.enum(['target-mismatch', 'invalid-candidate']),
  }).strict(),
  z.object({
    kind: z.literal('capacity'),
    resource: z.literal('board-work-items'),
    limit: z.literal(SAKI_BOARD_WORK_ITEM_LIMIT),
    observed: z.number().int()
      .min(SAKI_BOARD_WORK_ITEM_LIMIT + 1)
      .max(SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT),
  }).strict(),
  z.object({ kind: z.literal('attempt'), reason: z.literal('expired') }).strict(),
]).transform(value => value as SakiGitHubScanFailure)

const githubRateLimitProjectionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unobserved') }).strict(),
  z.object({
    state: z.literal('available'),
    observedAt: timestamp,
    minimumRemaining: z.number().int().nonnegative(),
    resetAt: timestamp,
  }).strict(),
  z.object({
    state: z.literal('limited'),
    observedAt: timestamp,
    resetAt: timestamp.optional(),
  }).strict(),
])

const boardWorkItemSchema = z.object({
  id: boardWorkItemId,
  title: githubSafeText,
  issueNumber: z.number().int().positive(),
  url: githubSafeUrl,
  issueState: z.enum(['open', 'closed']),
  status: boardStatusSchema,
  order: z.number().int().nonnegative(),
  archived: z.boolean(),
  notInProject: z.boolean(),
  updatedAt: timestamp,
  source: z.object({
    kind: z.literal('github-issue'),
    repositoryId: githubRepositoryIdSchema,
    issueId: githubIssueIdSchema,
    projectItemId: githubProjectItemIdSchema.optional(),
    apiOrder: z.number().int().nonnegative().optional(),
  }).strict(),
  remoteFingerprint: boardRemoteFingerprint,
}).strict().superRefine((value, context) => {
  const expectedId = `work-item-${v4CanonicalDigest('saki/board-work-item/v1', {
    repositoryId: value.source.repositoryId,
    issueId: value.source.issueId,
  })}`
  if (value.id !== expectedId) {
    context.addIssue({ code: 'custom', message: 'Work Item id disagrees with its GitHub Issue identity' })
  }
  const joined = value.source.projectItemId !== undefined || value.source.apiOrder !== undefined
  if (joined && (value.source.projectItemId === undefined || value.source.apiOrder === undefined)) {
    context.addIssue({ code: 'custom', message: 'joined Work Item source evidence is incomplete' })
  }
  if (value.notInProject === joined) {
    context.addIssue({ code: 'custom', message: 'Work Item membership disagrees with its source evidence' })
  }
  if (joined && value.order !== value.source.apiOrder) {
    context.addIssue({ code: 'custom', message: 'joined Work Item order disagrees with its Project API order' })
  }
  if (value.notInProject && (value.status !== 'inbox' || value.archived)) {
    context.addIssue({ code: 'custom', message: 'unjoined Work Item must be an unarchived Inbox card' })
  }
  if (value.notInProject && value.issueState !== 'open') {
    context.addIssue({ code: 'custom', message: 'unjoined Work Item must retain an open Issue' })
  }
  if (value.archived && value.status !== 'canceled') {
    context.addIssue({ code: 'custom', message: 'archived Work Item must be Canceled' })
  }
})

const confirmedBoardSchema = z.object({
  generation: z.number().int().positive(),
  configurationRevision: z.number().int().positive(),
  repository: z.object({
    id: githubRepositoryIdSchema,
    nameWithOwner: githubNameWithOwner,
    url: githubSafeUrl,
  }).strict(),
  project: z.object({
    id: githubProjectIdSchema,
    title: githubSafeText,
    url: githubSafeUrl,
  }).strict(),
  items: boundedArrayPreflight(
    SAKI_BOARD_WORK_ITEM_LIMIT,
    'confirmed Board exceeds the Work Item limit',
  ).pipe(z.array(boardWorkItemSchema)),
}).strict().superRefine((value, context) => {
  if (new Set(value.items.map(item => item.id)).size !== value.items.length) {
    context.addIssue({ code: 'custom', message: 'confirmed Board repeats Work Item ids' })
  }
  if (new Set(value.items.map(item => item.issueNumber)).size !== value.items.length) {
    context.addIssue({ code: 'custom', message: 'confirmed Board repeats a GitHub Issue number' })
  }
  const projectItemIds = value.items.flatMap(item => item.source.projectItemId === undefined
    ? []
    : [item.source.projectItemId])
  if (new Set(projectItemIds).size !== projectItemIds.length) {
    context.addIssue({ code: 'custom', message: 'confirmed Board repeats a GitHub Project Item identity' })
  }
  let previousOrder = -1
  for (const item of value.items) {
    if (previousOrder >= item.order) {
      context.addIssue({ code: 'custom', message: 'confirmed Board Work Item order must be strictly increasing' })
      break
    }
    previousOrder = item.order
  }
  const firstUnjoined = value.items.findIndex(item => item.notInProject)
  if (firstUnjoined >= 0 && value.items.slice(firstUnjoined + 1).some(item => !item.notInProject)) {
    context.addIssue({ code: 'custom', message: 'confirmed Board must order joined Work Items before unjoined Work Items' })
  }
})

const githubSyncCheckpointSchema = z.object({
  generation: z.number().int().positive(),
  configurationRevision: z.number().int().positive(),
  attemptId: githubScanAttemptId,
  installationId: githubInstallationIdSchema,
  repositoryId: githubRepositoryIdSchema,
  projectId: githubProjectIdSchema,
  statusFieldId: githubProjectFieldIdSchema,
  sourceFingerprint: githubProjectBoardFingerprintSchema,
  observedAt: timestamp,
  confirmedAt: timestamp,
  rateLimit: githubRateLimitProjectionSchema,
}).strict().refine(value => value.observedAt <= value.confirmedAt, {
  message: 'checkpoint confirmation cannot precede its observation',
  path: ['confirmedAt'],
})

const scheduledGitHubScanSchema = z.object({
  priority: z.enum(['interactive', 'background']),
  reason: z.enum(['startup', 'configuration', 'poll', 'interactive', 'retry']),
  attemptAt: timestamp,
}).strict()

const inFlightGitHubScanSchema = z.object({
  attemptId: githubScanAttemptId,
  priority: z.enum(['interactive', 'background']),
  configurationRevision: z.number().int().positive(),
  startedAt: timestamp,
  expiresAt: timestamp,
}).strict().refine(value => value.expiresAt > value.startedAt, 'scan attempt expiry must follow its start')

const currentGitHubScanFailureSchema = z.object({
  attemptId: githubScanAttemptId,
  configurationRevision: z.number().int().positive(),
  failedAt: timestamp,
  failure: sakiGitHubScanFailureSchema,
}).strict()

/** One bounded, independently revisioned GitHub synchronization aggregate per Development Project. */
export const v4GitHubProjectSyncRecordSchema = z.object({
  id: developmentProjectId,
  schemaVersion: z.literal(1),
  revision,
  installationId,
  nextCandidateRevision: z.number().int().positive(),
  nextBoardGeneration: z.number().int().positive(),
  active: activeGitHubSynchronizationConfigurationSchema.optional(),
  pending: githubSynchronizationCandidateSchema.optional(),
  confirmedBoard: confirmedBoardSchema.optional(),
  checkpoint: githubSyncCheckpointSchema.optional(),
  nextScanAttempt: scheduledGitHubScanSchema.optional(),
  inFlightAttempt: inFlightGitHubScanSchema.optional(),
  currentFailure: currentGitHubScanFailureSchema.optional(),
}).strict().superRefine((value, context) => {
  const greatestRevision = Math.max(value.active?.revision ?? 0, value.pending?.revision ?? 0)
  if (value.revision !== greatestRevision) {
    context.addIssue({ code: 'custom', message: 'synchronization revision disagrees with its current configuration' })
  }
  if (value.nextCandidateRevision !== greatestRevision + 1) {
    context.addIssue({ code: 'custom', message: 'next candidate revision does not immediately follow the current configuration' })
  }
  if (value.active !== undefined && value.pending !== undefined
    && value.pending.revision <= value.active.revision) {
    context.addIssue({ code: 'custom', message: 'pending configuration does not follow active configuration' })
  }
  if ((value.confirmedBoard === undefined) !== (value.checkpoint === undefined)) {
    context.addIssue({ code: 'custom', message: 'confirmed Board and checkpoint must be retained together' })
  }
  if ((value.active === undefined) !== (value.confirmedBoard === undefined)) {
    context.addIssue({ code: 'custom', message: 'active configuration and confirmed Board must be retained together' })
  }
  if (value.confirmedBoard !== undefined && value.checkpoint !== undefined) {
    if (value.active === undefined
      || value.confirmedBoard.generation !== value.checkpoint.generation
      || value.confirmedBoard.configurationRevision !== value.checkpoint.configurationRevision
      || value.active.revision !== value.checkpoint.configurationRevision) {
      context.addIssue({ code: 'custom', message: 'confirmed Board, checkpoint, and active configuration disagree' })
    }
    if (value.nextBoardGeneration <= value.confirmedBoard.generation) {
      context.addIssue({ code: 'custom', message: 'next Board generation is not monotonic' })
    }
    if (value.active !== undefined
      && (value.checkpoint.installationId !== value.active.configuration.githubInstallationId
        || value.checkpoint.repositoryId !== value.active.configuration.repositoryNodeId
        || value.checkpoint.projectId !== value.active.configuration.projectNodeId
        || value.checkpoint.statusFieldId !== value.active.configuration.statusFieldNodeId)) {
      context.addIssue({ code: 'custom', message: 'checkpoint target disagrees with active configuration' })
    }
    if (value.confirmedBoard.repository.id !== value.checkpoint.repositoryId
      || value.confirmedBoard.project.id !== value.checkpoint.projectId) {
      context.addIssue({ code: 'custom', message: 'confirmed Board target disagrees with its checkpoint' })
    }
    if (value.confirmedBoard.items.some(item => item.source.repositoryId !== value.confirmedBoard?.repository.id)) {
      context.addIssue({ code: 'custom', message: 'confirmed Board contains a Work Item from another Repository' })
    }
    const issueIds = value.confirmedBoard.items.map(item => item.source.issueId)
    if (new Set(issueIds).size !== issueIds.length) {
      context.addIssue({ code: 'custom', message: 'confirmed Board repeats a GitHub Issue identity' })
    }
  } else if (value.nextBoardGeneration !== 1) {
    context.addIssue({ code: 'custom', message: 'Board generation advanced without a confirmed Board' })
  }
  const scanConfigurationRevision = value.pending?.revision ?? value.active?.revision
  if (value.inFlightAttempt !== undefined
    && value.inFlightAttempt.configurationRevision !== scanConfigurationRevision) {
    context.addIssue({ code: 'custom', message: 'in-flight scan does not target the current configuration' })
  }
  if (value.pending?.state === 'activating'
    && value.inFlightAttempt?.configurationRevision !== value.pending.revision) {
    context.addIssue({ code: 'custom', message: 'activating configuration has no matching in-flight scan' })
  }
  if (value.pending?.state === 'activation-failed'
    && value.currentFailure?.configurationRevision !== value.pending.revision) {
    context.addIssue({ code: 'custom', message: 'failed configuration has no matching current failure' })
  }
  if (value.currentFailure !== undefined
    && value.currentFailure.configurationRevision !== scanConfigurationRevision) {
    context.addIssue({ code: 'custom', message: 'current failure does not target the current configuration' })
  }
  const currentConfiguration = value.pending?.configuration ?? value.active?.configuration
  const directMappingIssues = value.currentFailure?.failure.kind === 'mapping'
    ? value.currentFailure.failure.issues
    : []
  if (currentConfiguration !== undefined && directMappingIssues.length > 0) {
    const configuredOptionByStatus = {
      inbox: currentConfiguration.statusOptionNodeIds.inbox,
      backlog: currentConfiguration.statusOptionNodeIds.backlog,
      ready: currentConfiguration.statusOptionNodeIds.ready,
      'in-progress': currentConfiguration.statusOptionNodeIds.inProgress,
      'in-review': currentConfiguration.statusOptionNodeIds.inReview,
      done: currentConfiguration.statusOptionNodeIds.done,
      canceled: currentConfiguration.statusOptionNodeIds.canceled,
    } satisfies Record<z.infer<typeof boardStatusSchema>, string>
    if (directMappingIssues.some(issue => issue.reason === 'status-field-missing'
      && issue.statusFieldId !== currentConfiguration.statusFieldNodeId)) {
      context.addIssue({ code: 'custom', message: 'current mapping failure disagrees with the current Status field' })
    }
    if (directMappingIssues.some(issue => issue.reason === 'status-option-missing'
      && issue.statusOptionId !== configuredOptionByStatus[issue.status])) {
      context.addIssue({ code: 'custom', message: 'current mapping failure disagrees with the current Status options' })
    }
    const configuredOptionIds = new Set(Object.values(configuredOptionByStatus))
    if (directMappingIssues.some(issue => issue.reason === 'work-item-status-unknown'
      && configuredOptionIds.has(issue.statusOptionId))) {
      context.addIssue({ code: 'custom', message: 'current mapping failure treats a configured Status option as unknown' })
    }
  }
  const mappingMismatch = value.currentFailure?.failure.kind === 'provider'
    && value.currentFailure.failure.failure.code === 'mapping-mismatch'
    ? value.currentFailure.failure.failure
    : undefined
  if (mappingMismatch !== undefined && currentConfiguration !== undefined) {
    if (mappingMismatch.statusFieldId !== currentConfiguration.statusFieldNodeId) {
      context.addIssue({ code: 'custom', message: 'current mapping failure disagrees with the current Status field' })
    }
    if (mappingMismatch.reason === 'required-options-missing') {
      const configuredOptionIds = new Set(Object.values(currentConfiguration.statusOptionNodeIds))
      if (mappingMismatch.missingRequiredStatusOptionIds.some(optionId => !configuredOptionIds.has(optionId))) {
        context.addIssue({ code: 'custom', message: 'current mapping failure names an unconfigured Status option' })
      }
    }
  }
  if (value.currentFailure !== undefined
    && value.checkpoint !== undefined
    && value.currentFailure.configurationRevision === value.checkpoint.configurationRevision
    && value.currentFailure.failure.kind === 'provider'
    && value.currentFailure.failure.failure.code === 'mapping-mismatch'
    && value.currentFailure.failure.failure.statusFieldId !== value.checkpoint.statusFieldId) {
    context.addIssue({ code: 'custom', message: 'current mapping failure disagrees with the checkpoint Status field' })
  }
  if (value.nextScanAttempt !== undefined && scanConfigurationRevision === undefined) {
    context.addIssue({ code: 'custom', message: 'scan is scheduled without a synchronization configuration' })
  }
})

const githubConfigurationIntentRecordBaseSchema = z.object({
  id: controlIntentId,
  schemaVersion: z.literal(1),
  revision,
  receiptId: intentReceiptId,
  payloadDigest: digest,
  payload: z.object({
    intent: configureGitHubSynchronizationIntentSchema,
    actor: registrationActorSchema,
  }).strict(),
  phase: z.enum(['prepared', 'saved', 'conflict', 'failure']),
  candidateRevision: positiveRevision.optional(),
  synchronizationRevision: positiveRevision.optional(),
  terminalReason: z.enum([
    'expected-revision',
    'project-not-found',
    'configuration-incomplete',
    'configuration-unchanged',
    'authority',
  ]).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

/** Recoverable configuration Intent whose aggregate commit and receipt can survive acknowledgement loss. */
export const v4GitHubConfigurationIntentRecordSchema = githubConfigurationIntentRecordBaseSchema
  .superRefine((value, context) => {
    refineDurableIntentIdentity(value, context)
    if (v4CanonicalDigest('saki/configure-github-synchronization/v1', value.payload) !== value.payloadDigest) {
      context.addIssue({ code: 'custom', message: 'Intent payload digest is stale', path: ['payloadDigest'] })
    }
    if (value.updatedAt < value.createdAt) {
      context.addIssue({ code: 'custom', message: 'Intent update predates creation', path: ['updatedAt'] })
    }
    const savedEvidence = value.candidateRevision !== undefined || value.synchronizationRevision !== undefined
    if (value.phase === 'saved') {
      if (value.candidateRevision === undefined || value.synchronizationRevision === undefined
        || value.terminalReason !== undefined) {
        context.addIssue({ code: 'custom', message: 'saved Intent evidence is incomplete' })
      }
    } else if (savedEvidence) {
      context.addIssue({ code: 'custom', message: 'non-saved Intent retains candidate evidence' })
    }
    const terminal = value.phase === 'conflict' || value.phase === 'failure'
    if (terminal !== (value.terminalReason !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Intent terminal reason disagrees with phase' })
    }
    if (value.phase === 'failure' && value.terminalReason !== 'authority') {
      context.addIssue({ code: 'custom', message: 'failure phase has an invalid terminal reason' })
    }
    if (value.phase === 'conflict' && value.terminalReason === 'authority') {
      context.addIssue({ code: 'custom', message: 'conflict phase has an invalid terminal reason' })
    }
  })
/* jscpd:ignore-end */
