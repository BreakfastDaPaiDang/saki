/** Browser-safe Saki Host API schemas and inferred wire values. @module @breakfastdapaidang/saki-host-api/wire */

import { z } from 'zod'
import {
  canonicalDigest,
  commitHostOperationRequestSchema,
  commitHostOperationResultSchema,
  hostOperationIdSchema,
  inheritedChangeBaselineSchema,
  isGitObjectId,
  isSafeDisplayLocation,
  MAX_HOST_OPERATION_SELECTED_CHANGES,
  MAX_DISPLAY_LOCATION_CHARS,
  MAX_INVENTORY_ENTRIES,
  projectGitHeadSchema,
  projectGitStatusObservationSchema,
  projectGitStatusFingerprintSchema,
  projectGitWorktreeFingerprintSchema,
  projectInspectionFingerprintSchema,
  projectSelectionProjectionSchema,
  readProjectDiffRequestSchema,
  readProjectDiffResultSchema,
  sakiAgentProfileIdSchema,
  sakiAgentRunIdSchema,
  sakiExecutionDispatchIdSchema,
  sakiWorkSessionIdSchema,
  selectedProjectGitChangeSchema,
  stageFilesHostOperationResultSchema,
  unstageFilesHostOperationResultSchema,
} from '@breakfastdapaidang/saki-execution'
import {
  SAKI_BOARD_WORK_ITEM_LIMIT,
  SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
  SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
} from '@breakfastdapaidang/saki-control-plane/constants'
import type {
  AccessProjection,
  ConfigureGitHubSynchronizationIntent,
  CreateWorkItemIntent,
  CreateCommitIntent,
  GiveWorkItemToAgentIntent,
  GitMutationExpectation,
  GitHubAccountId,
  GitHubAppId,
  GitHubInstallationId,
  GitHubProjectFieldId,
  GitHubProjectId,
  GitHubProjectOptionId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryId,
  GitHubSynchronizationConfiguration,
  GitHubSynchronizationConfigurationField,
  GitHubSynchronizationConfigurationPatch,
  RegisterDevelopmentProjectIntent,
  SakiControlIntentId,
  SakiAgentRunProjection,
  SakiBoardProjection,
  SakiBoardMutationOverlayProjection,
  SakiBoardRemoteFingerprint,
  SakiBoardStatus,
  SakiBoardWorkItemId,
  SakiBoardWorkItemProjection,
  SakiDevelopmentProjectId,
  SakiDevelopmentProjectSummary,
  SakiDevelopmentWorkspaceProjection,
  SakiHostId,
  SakiIntentReceipt,
  SakiIntentInput,
  SakiIntentReceiptId,
  SakiWorkItemIntentReceipt,
  SakiGiveWorkItemToAgentIntentReceipt,
  SakiWorkAssignmentId,
  SakiWorkItemDetailProjection,
  SakiGitHubMappingHealthProjection,
  SakiGitHubMappingIssue,
  SakiGitHubRateLimitProjection,
  SakiGitHubScanAttemptId,
  SakiGitHubScanFailure,
  SakiGitHubScanStateProjection,
  SakiGitHubSyncCheckpointProjection,
  SakiGitHubSynchronizationFailureProjection,
  SakiCurrentGitOperationProjection,
  SakiGitOperationAvailabilityProjection,
  SakiGitOperationIntentReceipt,
  SakiGitOperationReferenceProjection,
  SakiGitOperationsProjection,
  SakiPrincipalId,
  SakiProjectIndexProjection,
  SakiProjectDiffProjection,
  SakiProjectChangesProjection,
  SakiProjectSettingsProjection,
  SakiProjectSelectionInspectionProjection,
  SakiQuery,
  SakiQueryResult,
  SakiResourceBindingId,
  StageFilesIntent,
  UnstageFilesIntent,
  MoveWorkItemIntent,
} from '@breakfastdapaidang/saki-control-plane'

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const brandedId = <T extends string>(prefix: string) => z.string()
  .regex(new RegExp(`^${prefix}-${UUID_PATTERN}$`))
  .transform(value => value as T)
const hostId = brandedId<SakiHostId>('host')
const principalId = brandedId<SakiPrincipalId>('principal')
const projectId = brandedId<SakiDevelopmentProjectId>('project')
const bindingId = brandedId<SakiResourceBindingId>('binding')
const intentId = brandedId<SakiControlIntentId>('intent')
const receiptId = brandedId<SakiIntentReceiptId>('receipt')
const assignmentId = brandedId<SakiWorkAssignmentId>('assignment')
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const revision = safeInteger
const positiveRevision = positiveInteger
const projectTitle = z.string().min(1).max(200).refine(value => value.trim().length > 0)
const directoryLocator = z.string().min(1).max(32_768)
const displayLocation = z.string().min(1).max(MAX_DISPLAY_LOCATION_CHARS).refine(isSafeDisplayLocation)
const githubPositiveDecimalId = <T extends string>() => z.string().regex(/^[1-9][0-9]*$/u).max(40)
  .transform(value => value as T)
const githubAppId = githubPositiveDecimalId<GitHubAppId>()
const githubNodeId = <T extends string>() => z.string().min(1).max(1_024)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .transform(value => value as T)
const credentialRef = z.string().min(1).max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .transform(value => value as GitHubSynchronizationConfiguration['credentialRef'])
const MIN_POLL_INTERVAL_MS = 1_000
const MAX_POLL_INTERVAL_MS = 86_400_000
const pollInterval = z.number().int().min(MIN_POLL_INTERVAL_MS).max(MAX_POLL_INTERVAL_MS)
const rateLimitReserve = z.number().int().nonnegative().max(5_000)
const safeName = z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/u)
const safeText = z.string().min(1).max(4_096).regex(/^[^\u0000\u007f]*$/u)
const safeRequestId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const safeUrl = z.url().max(2_048).refine((value) => {
  const parsed = new URL(value)
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hash === ''
}, 'URL must be credential-free HTTPS without a fragment')
const digest = z.string().regex(/^[0-9a-f]{64}$/u)
const boardWorkItemId = z.string().regex(/^work-item-[0-9a-f]{64}$/u)
  .transform(value => value as SakiBoardWorkItemId)
const scanAttemptId = z.string().regex(new RegExp(`^scan-attempt-${UUID_PATTERN}$`))
  .transform(value => value as SakiGitHubScanAttemptId)
const boardRemoteFingerprint = z.string().regex(/^remote-fingerprint-[0-9a-f]{64}$/u)
  .transform(value => value as SakiBoardRemoteFingerprint)
const sakiBoardStatusSchema = z.enum([
  'inbox',
  'backlog',
  'ready',
  'in-progress',
  'in-review',
  'done',
  'canceled',
]) satisfies z.ZodType<SakiBoardStatus>
function boundedArray<T extends z.ZodType>(element: T, minimum: number, maximum: number) {
  return z.custom<unknown[]>(value => Array.isArray(value)
    && value.length >= minimum
    && value.length <= maximum)
    .pipe(z.array(element))
}

/** Strict body schema for endpoints with no operation fields. */
export const sakiEmptyRequestSchema = z.object({}).strict()

/** Strict bootstrap exchange body schema. */
export const sakiBootstrapExchangeRequestSchema = z.object({
  secret: z.string().min(1).max(512),
}).strict()

/** Closed project-query body schema with branded cross-boundary ids. */
export const sakiQueryRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('inspect-project-selection'),
    hostId,
    directoryLocator,
  }).strict(),
  z.object({ type: z.literal('project-index') }).strict(),
  z.object({
    type: z.literal('development-workspace'),
    projectId,
    expectedRegistryRevision: revision,
  }).strict(),
  z.object({
    type: z.literal('project-changes'),
    projectId,
    expectedRegistryRevision: revision,
  }).strict(),
  z.object({
    type: z.literal('project-diff'),
    projectId,
    expectedRegistryRevision: revision,
    request: readProjectDiffRequestSchema,
  }).strict(),
  z.object({
    type: z.literal('project-settings'),
    projectId,
  }).strict(),
  z.object({
    type: z.literal('board'),
    projectId,
    refresh: z.enum(['cached', 'interactive']),
  }).strict(),
]) satisfies z.ZodType<SakiQuery>

/** Strict Development Project registration Intent. */
export const sakiRegisterDevelopmentProjectIntentSchema = z.object({
  type: z.literal('register-development-project'),
  intentId,
  projectTitle,
  hostId,
  directoryLocator,
  expectedRegistryRevision: revision,
  confirmedFingerprint: projectInspectionFingerprintSchema,
  confirmedBaseline: inheritedChangeBaselineSchema,
}).strict() satisfies z.ZodType<RegisterDevelopmentProjectIntent>

const githubStatusOptionMappingSchema = z.object({
  inbox: githubNodeId<GitHubProjectOptionId>(),
  backlog: githubNodeId<GitHubProjectOptionId>(),
  ready: githubNodeId<GitHubProjectOptionId>(),
  inProgress: githubNodeId<GitHubProjectOptionId>(),
  inReview: githubNodeId<GitHubProjectOptionId>(),
  done: githubNodeId<GitHubProjectOptionId>(),
  canceled: githubNodeId<GitHubProjectOptionId>(),
}).strict().superRefine((value, context) => {
  if (new Set(Object.values(value)).size !== Object.keys(value).length) {
    context.addIssue({ code: 'custom', message: 'GitHub Status option ids must be distinct' })
  }
})

const githubSynchronizationConfigurationShape = {
  appId: githubAppId,
  githubInstallationId: githubPositiveDecimalId<GitHubInstallationId>(),
  accountNodeId: githubNodeId<GitHubAccountId>(),
  repositoryNodeId: githubNodeId<GitHubRepositoryId>(),
  repositoryDatabaseId: githubPositiveDecimalId<GitHubRepositoryDatabaseId>(),
  projectNodeId: githubNodeId<GitHubProjectId>(),
  credentialRef,
  statusFieldNodeId: githubNodeId<GitHubProjectFieldId>(),
  statusOptionNodeIds: githubStatusOptionMappingSchema,
  activePollIntervalMs: pollInterval,
  backgroundPollIntervalMs: pollInterval,
  rateLimitReserve,
} as const

const githubSynchronizationConfigurationSchema = z.object(
  githubSynchronizationConfigurationShape,
).strict() satisfies z.ZodType<GitHubSynchronizationConfiguration>

const githubSynchronizationConfigurationField = z.enum([
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
const GITHUB_SYNCHRONIZATION_CONFIGURATION_FIELDS = githubSynchronizationConfigurationField.options

const githubSynchronizationConfigurationPatchSchema = z.object(
  githubSynchronizationConfigurationShape,
).partial().strict()
  .transform((value): GitHubSynchronizationConfigurationPatch => Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as GitHubSynchronizationConfigurationPatch)
  .refine(value => Object.keys(value).length > 0, 'configuration patch must change at least one field')

/** Strict field-scoped GitHub synchronization configuration Intent. */
export const sakiConfigureGitHubSynchronizationIntentSchema = z.object({
  type: z.literal('configure-github-synchronization'),
  intentId,
  projectId,
  expectedSynchronizationRevision: revision,
  patch: githubSynchronizationConfigurationPatchSchema,
}).strict() satisfies z.ZodType<ConfigureGitHubSynchronizationIntent>

/** Browser-supplied status evidence without trusted Binding or baseline authority. */
// This browser boundary must not import the Node-facing durable Control Plane schema it independently validates.
/* jscpd:ignore-start */
export const sakiGitMutationExpectationSchema = z.object({
  projectId,
  expectedRegistryRevision: revision,
  expectedProjectRevision: revision,
  expectedBinding: z.object({ id: bindingId, revision }).strict(),
  expectedStatus: projectGitStatusFingerprintSchema,
  expectedHead: projectGitHeadSchema,
  expectedIndex: z.object({ kind: z.literal('tree'), treeId: z.string().refine(value => isGitObjectId(value)) }).strict(),
  expectedWorktree: projectGitWorktreeFingerprintSchema,
}).strict().superRefine((value, context) => {
  if (value.expectedHead.kind === 'commit'
    && value.expectedHead.objectId.length !== value.expectedIndex.treeId.length) {
    context.addIssue({
      code: 'custom',
      message: 'expected HEAD and index use different object formats',
      path: ['expectedIndex', 'treeId'],
    })
  }
}) satisfies z.ZodType<GitMutationExpectation>
/* jscpd:ignore-end */

const sakiSelectedGitChangesSchema = boundedArray(
  selectedProjectGitChangeSchema,
  1,
  MAX_HOST_OPERATION_SELECTED_CHANGES,
)
  .superRefine((changes, context) => {
    if (new Set(changes.map(change => change.id)).size !== changes.length) {
      context.addIssue({ code: 'custom', message: 'selected changes repeat a change id' })
    }
  })

/** Strict path-free StageFiles Control Intent. */
export const sakiStageFilesIntentSchema = z.object({
  type: z.literal('stage-files'),
  intentId,
  expected: sakiGitMutationExpectationSchema,
  changes: sakiSelectedGitChangesSchema,
}).strict() satisfies z.ZodType<StageFilesIntent>

/** Strict path-free UnstageFiles Control Intent. */
export const sakiUnstageFilesIntentSchema = z.object({
  type: z.literal('unstage-files'),
  intentId,
  expected: sakiGitMutationExpectationSchema,
  changes: sakiSelectedGitChangesSchema,
}).strict() satisfies z.ZodType<UnstageFilesIntent>

const sakiCommitMessageSchema = commitHostOperationRequestSchema.shape.message

/** Strict Commit Control Intent without caller-supplied Git identity or ref authority. */
export const sakiCreateCommitIntentSchema = z.object({
  type: z.literal('create-commit'),
  intentId,
  expected: sakiGitMutationExpectationSchema,
  message: sakiCommitMessageSchema,
}).strict() satisfies z.ZodType<CreateCommitIntent>

const sakiCreateWorkItemExpectationSchema = z.object({
  projectRevision: revision,
  synchronizationRevision: positiveRevision,
  mappingRevision: positiveRevision,
}).strict()

/** Strict Work Item creation Intent without GitHub authority or marker fields. */
export const sakiCreateWorkItemIntentSchema = z.object({
  type: z.literal('create-work-item'),
  intentId,
  projectId,
  expected: sakiCreateWorkItemExpectationSchema,
  title: projectTitle,
  intendedOutcome: safeText,
  acceptanceCriteria: boundedArray(safeText, 1, 50),
}).strict() satisfies z.ZodType<CreateWorkItemIntent>

const sakiMoveWorkItemPositionSchema = z.union([
  z.object({ afterWorkItemId: z.null() }).strict(),
  z.object({
    afterWorkItemId: boardWorkItemId,
    expectedAfterRemoteFingerprint: boardRemoteFingerprint,
  }).strict(),
])

/** Strict Work Item movement Intent with only Saki-relative placement authority. */
export const sakiMoveWorkItemIntentSchema = z.object({
  type: z.literal('move-work-item'),
  intentId,
  projectId,
  workItemId: boardWorkItemId,
  expectedRemoteFingerprint: boardRemoteFingerprint,
  targetStatus: sakiBoardStatusSchema,
  position: sakiMoveWorkItemPositionSchema.optional(),
}).strict().superRefine((intent, context) => {
  if (intent.position?.afterWorkItemId === intent.workItemId) {
    context.addIssue({ code: 'custom', message: 'Work Item cannot be positioned after itself' })
  }
}) satisfies z.ZodType<MoveWorkItemIntent>

/** Strict manual Agent assignment Intent without execution or Host authority. */
export const sakiGiveWorkItemToAgentIntentSchema = z.object({
  type: z.literal('give-work-item-to-agent'),
  intentId,
  projectId,
  workItemId: boardWorkItemId,
  expectedProjectRevision: revision,
  expectedRemoteFingerprint: boardRemoteFingerprint,
}).strict() satisfies z.ZodType<GiveWorkItemToAgentIntent>

/** Closed Control Intent request union. */
export const sakiIntentRequestSchema = z.discriminatedUnion('type', [
  sakiRegisterDevelopmentProjectIntentSchema,
  sakiConfigureGitHubSynchronizationIntentSchema,
  sakiStageFilesIntentSchema,
  sakiUnstageFilesIntentSchema,
  sakiCreateCommitIntentSchema,
  sakiCreateWorkItemIntentSchema,
  sakiMoveWorkItemIntentSchema,
  sakiGiveWorkItemToAgentIntentSchema,
]) satisfies z.ZodType<SakiIntentInput>

/** Authenticated member of the Access Projection schema. */
export const sakiAuthenticatedAccessProjectionSchema = z.object({
  kind: z.literal('authenticated'),
  principal: z.object({ id: principalId, displayName: z.string().min(1) }).strict(),
  expiresAt: z.number().int().nonnegative(),
  requestToken: z.string().min(1),
}).strict()

/** Display-safe Access Projection schema with fixed unauthenticated messages. */
export const sakiAccessProjectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bootstrap-required'),
    message: z.literal('Local bootstrap is required.'),
  }).strict(),
  z.object({
    kind: z.literal('session-required'),
    message: z.literal('A local browser session is required.'),
  }).strict(),
  z.object({
    kind: z.literal('unavailable'),
    message: z.literal('Local access is temporarily unavailable.'),
  }).strict(),
  sakiAuthenticatedAccessProjectionSchema,
]) satisfies z.ZodType<AccessProjection>

/** Bootstrap exchange business-result schema. */
export const sakiAccessExchangeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), access: sakiAuthenticatedAccessProjectionSchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.literal('unavailable') }).strict(),
])

/** Logout business-result schema. */
export const sakiAccessLogoutResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.literal('unavailable') }).strict(),
])

const configurationGap = z.enum([
  'baseline-unavailable',
  'conversion-ambiguous',
  'binding-missing',
  'binding-repair-required',
])

const projectSummaryWireSchema = z.object({
  id: projectId,
  revision,
  projectTitle,
  binding: z.object({
    id: bindingId,
    revision,
    health: z.enum(['active', 'missing', 'repair-required']),
    hostId,
    displayLocation,
    objectFormat: z.enum(['sha1', 'sha256']),
    head: projectGitHeadSchema,
    inheritedChangeEntryCount: revision.max(MAX_INVENTORY_ENTRIES),
    baseline: z.enum(['complete', 'unavailable']),
    automaticMutationEligible: z.boolean(),
    configurationGaps: z.array(configurationGap).max(3),
  }).strict(),
}).strict()

const projectSummarySchema = projectSummaryWireSchema.superRefine((value, context) => {
  const expectedObjectLength = value.binding.objectFormat === 'sha1' ? 40 : 64
  if (value.binding.head.kind === 'commit'
    && value.binding.head.objectId.length !== expectedObjectLength) {
    context.addIssue({
      code: 'custom',
      message: 'summary HEAD does not match object format',
      path: ['binding', 'head', 'objectId'],
    })
  }
  if (new Set(value.binding.configurationGaps).size !== value.binding.configurationGaps.length) {
    context.addIssue({ code: 'custom', message: 'summary contains duplicate configuration gaps' })
  }
  const eligible = value.binding.health === 'active'
    && value.binding.inheritedChangeEntryCount === 0
    && value.binding.baseline === 'complete'
    && value.binding.configurationGaps.length === 0
  if (value.binding.automaticMutationEligible && !eligible) {
    context.addIssue({ code: 'custom', message: 'summary eligibility disagrees with blocking evidence' })
  }
}).transform((value): SakiDevelopmentProjectSummary => value)

/** Revisioned Project-index Projection schema. */
export const sakiProjectIndexProjectionSchema = z.object({
  type: z.literal('project-index'),
  revision,
  hosts: z.array(z.object({ id: hostId, revision, state: z.literal('enrolled') }).strict()),
  projects: z.array(projectSummarySchema),
}).strict() satisfies z.ZodType<SakiProjectIndexProjection>

/** Protected selection-inspection Projection schema. */
export const sakiProjectSelectionInspectionProjectionSchema = z.object({
  type: z.literal('inspect-project-selection'),
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), selection: projectSelectionProjectionSchema }).strict(),
    z.object({ ok: z.literal(false), reason: z.enum([
      'missing', 'not-directory', 'not-git', 'bare', 'prunable', 'ambiguous', 'malformed', 'unavailable',
    ]) }).strict(),
  ]),
}).strict() satisfies z.ZodType<SakiProjectSelectionInspectionProjection>

/** Development Workspace Projection schema. */
export const sakiDevelopmentWorkspaceProjectionSchema = z.object({
  type: z.literal('development-workspace'),
  registryRevision: revision,
  project: projectSummarySchema,
  currentSelection: projectSelectionProjectionSchema.optional(),
  recovery: z.object({
    state: z.enum(['ready', 'blocked']),
    reasons: z.array(z.enum([
      'binding-missing',
      'binding-repair-required',
      'baseline-unavailable',
      'conversion-ambiguous',
      'dirty',
      'locked',
    ])).max(6).refine(values => new Set(values).size === values.length),
  }).strict(),
}).strict().transform((value): SakiDevelopmentWorkspaceProjection => {
  const { currentSelection, ...projection } = value
  return { ...projection, ...(currentSelection === undefined ? {} : { currentSelection }) }
}) satisfies z.ZodType<SakiDevelopmentWorkspaceProjection>

/** Structured Project-status Projection schema with no trusted Binding evidence. */
const sakiProjectChangesObservationResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    observation: projectGitStatusObservationSchema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'binding-stale', 'missing', 'malformed', 'limit', 'invalid-path', 'ambiguous', 'unavailable',
    ]),
  }).strict(),
])

const gitOperationUnavailableReason = z.enum([
  'baseline-unavailable',
  'conversion-ambiguous',
  'current-unavailable',
  'index-flags',
  'unmerged',
  'locked',
  'detached-head',
  'no-staged-changes',
  'status-unavailable',
  'action-denied',
  'write-admission-busy',
  'write-admission-unavailable',
])
const GIT_OPERATION_UNAVAILABLE_REASON_ORDER = gitOperationUnavailableReason.options

/** Repository-level structured Git operation eligibility. */
export const sakiGitOperationAvailabilitySchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), reasons: z.tuple([]) }).strict(),
  z.object({
    available: z.literal(false),
    reasons: z.array(gitOperationUnavailableReason).min(1).max(gitOperationUnavailableReason.options.length)
      .refine((reasons) => {
        const canonical = [...new Set(reasons)].sort((left, right) =>
          GIT_OPERATION_UNAVAILABLE_REASON_ORDER.indexOf(left)
          - GIT_OPERATION_UNAVAILABLE_REASON_ORDER.indexOf(right))
        return canonical.length === reasons.length
          && canonical.every((reason, index) => reason === reasons[index])
      }),
  }).strict(),
]) satisfies z.ZodType<SakiGitOperationAvailabilityProjection>

const gitOperationReferenceShape = {
  id: hostOperationIdSchema,
  type: z.enum(['stage-files', 'unstage-files', 'commit']),
  revision,
} as const
const hostOperationState = z.enum([
  'prepared', 'accepted', 'planning', 'publishing',
  'succeeded', 'failed', 'canceled', 'reconciliation-required',
])

/** Browser-safe Host Operation reference with no routing or admission evidence. */
export const sakiGitOperationReferenceProjectionSchema = z.object({
  ...gitOperationReferenceShape,
  state: hostOperationState,
}).strict() satisfies z.ZodType<SakiGitOperationReferenceProjection>

/** Current structured Git operation without Host routing or admission evidence. */
export const sakiCurrentGitOperationProjectionSchema = z.discriminatedUnion('state', [
  z.object({
    intentId,
    type: z.enum(['stage-files', 'unstage-files', 'create-commit']),
    state: z.literal('admission-reserved'),
  }).strict(),
  z.object({
    intentId,
    type: z.enum(['stage-files', 'unstage-files', 'create-commit']),
    state: z.literal('host-prepared'),
    operation: z.object({ ...gitOperationReferenceShape, state: z.literal('prepared') }).strict(),
  }).strict(),
  z.object({
    intentId,
    type: z.enum(['stage-files', 'unstage-files', 'create-commit']),
    state: z.literal('accepted'),
    operation: z.object({
      ...gitOperationReferenceShape,
      state: z.enum(['accepted', 'planning', 'publishing']),
    }).strict(),
  }).strict(),
  z.object({
    intentId,
    type: z.enum(['stage-files', 'unstage-files', 'create-commit']),
    state: z.literal('reconciliation-required'),
    operation: z.object({ ...gitOperationReferenceShape, state: z.literal('reconciliation-required') }).strict(),
  }).strict(),
]).superRefine((value, context) => {
  if ('operation' in value) {
    const expectedType = value.type === 'create-commit' ? 'commit' : value.type
    if (value.operation.type !== expectedType) {
      context.addIssue({ code: 'custom', message: 'operation type disagrees with Intent type', path: ['operation', 'type'] })
    }
  }
}).transform((value): SakiCurrentGitOperationProjection => {
  // The preceding refinement establishes the Intent-to-Host-kind correlation that Zod cannot infer.
  return value as SakiCurrentGitOperationProjection
}) satisfies z.ZodType<SakiCurrentGitOperationProjection>

/** Structured Git action eligibility and current single-writer owner. */
export const sakiGitOperationsProjectionSchema = z.object({
  stageFiles: sakiGitOperationAvailabilitySchema,
  unstageFiles: sakiGitOperationAvailabilitySchema,
  createCommit: sakiGitOperationAvailabilitySchema,
  current: sakiCurrentGitOperationProjectionSchema.optional(),
}).strict().transform((value): SakiGitOperationsProjection => {
  const { current, ...operations } = value
  return { ...operations, ...(current === undefined ? {} : { current }) }
})

/** Structured Project-status Projection schema with no trusted Binding evidence. */
export const sakiProjectChangesProjectionSchema = z.object({
  type: z.literal('project-changes'),
  registryRevision: revision,
  projectId,
  projectRevision: revision,
  result: sakiProjectChangesObservationResultSchema,
  gitOperations: sakiGitOperationsProjectionSchema,
}).strict().superRefine((projection, context) => {
  const actions = [
    ['stageFiles', projection.gitOperations.stageFiles],
    ['unstageFiles', projection.gitOperations.unstageFiles],
    ['createCommit', projection.gitOperations.createCommit],
  ] as const
  const statusReasons = [
    ...(projection.result.ok ? projection.result.observation.structuredMutation.available
      ? []
      : projection.result.observation.structuredMutation.blockers : ['status-unavailable'] as const),
  ]
  const noStagedChanges = projection.result.ok
    && projection.result.observation.structuredMutation.available
    && !projection.result.observation.changes.some(change =>
      change.kind === 'ordinary' && change.indexStatus !== 'unchanged')
  for (const [name, action] of actions) {
    const requiredReasons = [
      ...statusReasons,
      ...(name === 'createCommit'
        && projection.result.ok
        && projection.result.observation.branch.kind === 'detached'
        ? ['detached-head'] as const
        : []),
      ...(name === 'createCommit' && noStagedChanges ? ['no-staged-changes'] as const : []),
      ...(projection.gitOperations.current === undefined ? [] : ['write-admission-busy'] as const),
    ]
    const actualFactReasons = action.available ? [] : action.reasons.filter(reason =>
      reason !== 'action-denied' && reason !== 'write-admission-unavailable')
    if (actualFactReasons.length !== requiredReasons.length
      || actualFactReasons.some((reason, index) => reason !== requiredReasons[index])) {
      context.addIssue({
        code: 'custom',
        message: 'operation eligibility disagrees with status or current write admission',
        path: ['gitOperations', name],
      })
    }
  }
}) satisfies z.ZodType<SakiProjectChangesProjection>

/** Bounded file-scoped Project-Diff Projection schema. */
export const sakiProjectDiffProjectionSchema = z.object({
  type: z.literal('project-diff'),
  registryRevision: revision,
  projectId,
  projectRevision: revision,
  result: readProjectDiffResultSchema,
}).strict() satisfies z.ZodType<SakiProjectDiffProjection>

const githubMappingIssueSchema = z.discriminatedUnion('reason', [
  z.object({
    reason: z.literal('status-field-missing'),
    statusFieldId: githubNodeId<GitHubProjectFieldId>(),
  }).strict(),
  z.object({
    reason: z.literal('status-option-missing'),
    status: sakiBoardStatusSchema,
    statusOptionId: githubNodeId<GitHubProjectOptionId>(),
  }).strict(),
  z.object({
    reason: z.literal('work-item-status-missing'),
    issueId: githubNodeId<SakiBoardWorkItemProjection['source']['issueId']>(),
  }).strict(),
  z.object({
    reason: z.literal('work-item-status-unknown'),
    issueId: githubNodeId<SakiBoardWorkItemProjection['source']['issueId']>(),
    statusOptionId: githubNodeId<GitHubProjectOptionId>(),
  }).strict(),
]) satisfies z.ZodType<SakiGitHubMappingIssue>

const githubMappingIssueListSchema = boundedArray(
  githubMappingIssueSchema,
  1,
  SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
)
  .superRefine((issues, context) => {
    const itemIssueIds = new Set<string>()
    const optionIds = new Set<string>()
    const optionStatuses = new Set<SakiBoardStatus>()
    let fieldIssueCount = 0
    let itemIssueCount = 0
    let optionIssueCount = 0
    for (const issue of issues) {
      switch (issue.reason) {
        case 'status-field-missing':
          fieldIssueCount += 1
          break
        case 'status-option-missing':
          optionIssueCount += 1
          if (optionIds.has(issue.statusOptionId) || optionStatuses.has(issue.status)) {
            context.addIssue({ code: 'custom', message: 'GitHub mapping evidence repeats a Status option identity' })
          }
          optionIds.add(issue.statusOptionId)
          optionStatuses.add(issue.status)
          break
        case 'work-item-status-missing':
        case 'work-item-status-unknown':
          itemIssueCount += 1
          if (itemIssueIds.has(issue.issueId)) {
            context.addIssue({ code: 'custom', message: 'GitHub mapping evidence repeats a Work Item identity' })
          }
          itemIssueIds.add(issue.issueId)
          break
      }
    }
    if (fieldIssueCount > 0 && issues.length !== 1) {
      context.addIssue({ code: 'custom', message: 'a missing Status field must be the only mapping issue' })
    }
    if (optionIssueCount > STATUS_OPTION_FIELDS.length) {
      context.addIssue({ code: 'custom', message: 'GitHub mapping evidence exceeds the configured Status options' })
    }
    if (itemIssueCount > SAKI_BOARD_WORK_ITEM_LIMIT) {
      context.addIssue({ code: 'custom', message: 'GitHub mapping evidence exceeds the Board Work Item limit' })
    }
  })

// Browser input must remain independently validated without loading provider or durable-state modules.
/* jscpd:ignore-start */
const standardGitHubProviderFailureSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('cancelled') }).strict(),
  z.object({ code: z.literal('auth-unavailable'), credentialRef: credentialRef.optional() }).strict(),
  z.object({
    code: z.literal('permission-mismatch'),
    permission: safeName,
    required: z.enum(['none', 'read', 'write', 'admin']),
    observed: z.enum(['none', 'read', 'write', 'admin']).optional(),
    requestId: safeRequestId.optional(),
  }).strict(),
  z.object({ code: z.literal('not-found'), resource: safeName, requestId: safeRequestId.optional() }).strict(),
  z.object({
    code: z.literal('invalid-external-response'),
    operation: safeName,
    requestId: safeRequestId.optional(),
  }).strict(),
  z.object({
    code: z.literal('primary-rate-limit'),
    resetAt: safeInteger.optional(),
    requestId: safeRequestId.optional(),
  }).strict(),
  z.object({
    code: z.literal('secondary-rate-limit'),
    retryAfterMs: safeInteger.optional(),
    requestId: safeRequestId.optional(),
  }).strict(),
  z.object({
    code: z.literal('transient-transport'),
    retryAfterMs: safeInteger.optional(),
    requestId: safeRequestId.optional(),
  }).strict(),
  z.object({
    code: z.literal('permanent-rejection'),
    status: z.number().int().min(100).max(599).optional(),
    requestId: safeRequestId.optional(),
  }).strict(),
])

const githubMappingMismatchFailureSchema = z.discriminatedUnion('reason', [
  z.object({
    code: z.literal('mapping-mismatch'),
    reason: z.literal('field-missing-or-not-single-select'),
    statusFieldId: githubNodeId<GitHubProjectFieldId>(),
  }).strict(),
  z.object({
    code: z.literal('mapping-mismatch'),
    reason: z.literal('required-options-missing'),
    statusFieldId: githubNodeId<GitHubProjectFieldId>(),
    missingRequiredStatusOptionIds: z.array(githubNodeId<GitHubProjectOptionId>()).min(1).max(100)
      .refine(ids => new Set(ids).size === ids.length),
  }).strict(),
])
const githubProviderFailureSchema = z.union([
  standardGitHubProviderFailureSchema,
  githubMappingMismatchFailureSchema,
])

const githubScanFailureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('provider'), failure: githubProviderFailureSchema }).strict(),
  z.object({
    kind: z.literal('mapping'),
    issues: githubMappingIssueListSchema,
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
]) satisfies z.ZodType<SakiGitHubScanFailure>
/* jscpd:ignore-end */

const githubSynchronizationFailureProjectionSchema = z.object({
  attemptId: scanAttemptId,
  configurationRevision: positiveRevision,
  failedAt: safeInteger,
  failure: githubScanFailureSchema,
}).strict() satisfies z.ZodType<SakiGitHubSynchronizationFailureProjection>

const githubUnconfiguredMappingSchema = z.object({ state: z.literal('unconfigured') }).strict()
const githubRevalidationMappingSchema = z.object({
  state: z.literal('revalidation-required'),
  configurationRevision: positiveRevision,
}).strict()
const githubRepairMappingSchema = z.object({
  state: z.literal('repair-required'),
  configurationRevision: positiveRevision,
  issues: githubMappingIssueListSchema,
}).strict()
const githubValidMappingSchema = z.object({
  state: z.literal('valid'),
  configurationRevision: positiveRevision,
  validatedAt: safeInteger,
}).strict()
const githubConfiguredMappingBeforeCheckpointSchema = z.discriminatedUnion('state', [
  githubRevalidationMappingSchema,
  githubRepairMappingSchema,
])
const githubMappingHealthSchema = z.discriminatedUnion('state', [
  githubUnconfiguredMappingSchema,
  githubRevalidationMappingSchema,
  githubRepairMappingSchema,
  githubValidMappingSchema,
]) satisfies z.ZodType<SakiGitHubMappingHealthProjection>

const githubRateLimitSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unobserved') }).strict(),
  z.object({
    state: z.literal('available'),
    observedAt: safeInteger,
    minimumRemaining: safeInteger,
    resetAt: safeInteger,
  }).strict(),
  z.object({
    state: z.literal('limited'),
    observedAt: safeInteger,
    resetAt: safeInteger.optional(),
  }).strict(),
]) satisfies z.ZodType<SakiGitHubRateLimitProjection>

const githubSyncCheckpointSchema = z.object({
  generation: positiveRevision,
  configurationRevision: positiveRevision,
  attemptId: scanAttemptId,
  installationId: githubPositiveDecimalId<GitHubInstallationId>(),
  repositoryId: githubNodeId<GitHubRepositoryId>(),
  projectId: githubNodeId<GitHubProjectId>(),
  statusFieldId: githubNodeId<GitHubProjectFieldId>(),
  sourceFingerprint: z.object({ version: z.literal(1), digest }).strict(),
  observedAt: safeInteger,
  confirmedAt: safeInteger,
  rateLimit: githubRateLimitSchema,
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.observedAt > checkpoint.confirmedAt) {
    context.addIssue({ code: 'custom', message: 'checkpoint confirmation predates its observation' })
  }
}) satisfies z.ZodType<SakiGitHubSyncCheckpointProjection>

const boardUnavailableFreshnessSchema = z.object({ state: z.literal('unavailable') }).strict()
const boardAvailableFreshnessSchema = z.object({
  state: z.enum(['fresh', 'stale']),
  confirmedAt: safeInteger,
  staleAt: safeInteger,
  ageMs: safeInteger,
}).strict()
const boardFreshnessSchema = z.discriminatedUnion('state', [
  boardUnavailableFreshnessSchema,
  z.object({
    state: z.literal('fresh'),
    confirmedAt: safeInteger,
    staleAt: safeInteger,
    ageMs: safeInteger,
  }).strict(),
  z.object({
    state: z.literal('stale'),
    confirmedAt: safeInteger,
    staleAt: safeInteger,
    ageMs: safeInteger,
  }).strict(),
])

const githubIdleScanSchema = z.object({ state: z.literal('idle') }).strict()
const githubScanStateSchema = z.discriminatedUnion('state', [
  githubIdleScanSchema,
  z.object({
    state: z.literal('scheduled'),
    priority: z.enum(['interactive', 'background']),
    reason: z.enum(['startup', 'configuration', 'poll', 'interactive', 'retry']),
    attemptAt: safeInteger,
  }).strict(),
  z.object({
    state: z.literal('in-flight'),
    attemptId: scanAttemptId,
    priority: z.enum(['interactive', 'background']),
    configurationRevision: positiveRevision,
    startedAt: safeInteger,
    expiresAt: safeInteger,
  }).strict().refine(scan => scan.expiresAt > scan.startedAt, 'scan attempt expiry must follow its start'),
]) satisfies z.ZodType<SakiGitHubScanStateProjection>

const boardMutationUnavailableReason = z.enum([
  'synchronization-unconfigured',
  'configuration-not-activated',
  'mapping-revalidation-required',
  'mapping-repair-required',
  'checkpoint-unavailable',
  'provider-unavailable',
  'action-denied',
])
/** Exact effective Work Item mutation availability exposed to the browser. */
export const sakiBoardMutationAvailabilitySchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), reasons: z.tuple([]) }).strict(),
  z.object({
    available: z.literal(false),
    reasons: z.array(boardMutationUnavailableReason).min(1).max(7)
      .refine(reasons => new Set(reasons).size === reasons.length),
  }).strict(),
]) satisfies z.ZodType<SakiBoardProjection['effectiveMutationAvailability']>

type MappingState = SakiGitHubMappingHealthProjection['state']
type MutationReason = z.infer<typeof boardMutationUnavailableReason>

function expectedMutationUnavailableReasons(
  configuration: 'unconfigured' | 'not-activated' | 'activated',
  mapping: MappingState,
  hasCheckpoint: boolean,
): readonly MutationReason[] {
  const reasons: MutationReason[] = []
  if (configuration === 'unconfigured') reasons.push('synchronization-unconfigured')
  if (configuration === 'not-activated') reasons.push('configuration-not-activated')
  if (mapping === 'revalidation-required') reasons.push('mapping-revalidation-required')
  if (mapping === 'repair-required') reasons.push('mapping-repair-required')
  if (!hasCheckpoint) reasons.push('checkpoint-unavailable')
  return reasons
}

function validateMutationAvailability(
  actual: SakiBoardProjection['effectiveMutationAvailability'],
  expected: readonly MutationReason[],
  context: z.RefinementCtx,
): void {
  if (actual.available) {
    if (expected.length === 0) return
    context.addIssue({
      code: 'custom',
      message: 'effective mutation reasons disagree with synchronization evidence',
      path: ['effectiveMutationAvailability'],
    })
    return
  }
  const actualSet = new Set(actual.reasons)
  const operationalReasons = new Set<MutationReason>(['provider-unavailable', 'action-denied'])
  const unexpected = actual.reasons.some(reason => !expected.includes(reason) && !operationalReasons.has(reason))
  if (unexpected || expected.some(reason => !actualSet.has(reason))) {
    context.addIssue({
      code: 'custom',
      message: 'effective mutation reasons disagree with synchronization evidence',
      path: ['effectiveMutationAvailability', 'reasons'],
    })
  }
}

function mappingFailureRequiresRepair(failure: SakiGitHubSynchronizationFailureProjection | undefined): boolean {
  return failure?.failure.kind === 'mapping'
    || (failure?.failure.kind === 'provider' && failure.failure.failure.code === 'mapping-mismatch')
}

const STATUS_OPTION_FIELDS = [
  ['inbox', 'inbox'],
  ['backlog', 'backlog'],
  ['ready', 'ready'],
  ['inProgress', 'in-progress'],
  ['inReview', 'in-review'],
  ['done', 'done'],
  ['canceled', 'canceled'],
] as const

function sameMappingIssues(
  left: readonly SakiGitHubMappingIssue[],
  right: readonly SakiGitHubMappingIssue[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((issue, index) => {
    const other = right[index]
    if (other === undefined || issue.reason !== other.reason) return false
    switch (issue.reason) {
      case 'status-field-missing':
        return other.reason === issue.reason && issue.statusFieldId === other.statusFieldId
      case 'status-option-missing':
        return other.reason === issue.reason
          && issue.status === other.status
          && issue.statusOptionId === other.statusOptionId
      case 'work-item-status-missing':
        return other.reason === issue.reason && issue.issueId === other.issueId
      case 'work-item-status-unknown':
        return other.reason === issue.reason
          && issue.issueId === other.issueId
          && issue.statusOptionId === other.statusOptionId
    }
  })
}

function validateMappingRepairEvidence(
  mapping: Exclude<SakiGitHubMappingHealthProjection, { readonly state: 'unconfigured' }>,
  failure: SakiGitHubSynchronizationFailureProjection | undefined,
  configuration: GitHubSynchronizationConfiguration | undefined,
  context: z.RefinementCtx,
): void {
  if (mapping.state !== 'repair-required' || failure === undefined) return
  if (failure.failure.kind === 'mapping') {
    if (!sameMappingIssues(mapping.issues, failure.failure.issues)) {
      context.addIssue({ code: 'custom', message: 'mapping repair issues disagree with the current failure' })
    }
    if (configuration !== undefined) {
      const configuredOptionByStatus = new Map(STATUS_OPTION_FIELDS.map(([field, status]) => [
        status,
        configuration.statusOptionNodeIds[field],
      ] as const))
      const configuredOptionIds = new Set(configuredOptionByStatus.values())
      for (const issue of mapping.issues) {
        if (issue.reason === 'status-field-missing'
          && issue.statusFieldId !== configuration.statusFieldNodeId) {
          context.addIssue({ code: 'custom', message: 'mapping repair names another configured Status field' })
        }
        if (issue.reason === 'status-option-missing'
          && issue.statusOptionId !== configuredOptionByStatus.get(issue.status)) {
          context.addIssue({ code: 'custom', message: 'mapping repair names another configured Status option' })
        }
        if (issue.reason === 'work-item-status-unknown'
          && configuredOptionIds.has(issue.statusOptionId)) {
          context.addIssue({ code: 'custom', message: 'mapping repair treats a configured Status option as unknown' })
        }
      }
    }
    return
  }
  if (failure.failure.kind !== 'provider' || failure.failure.failure.code !== 'mapping-mismatch') return
  const mismatch = failure.failure.failure
  if (configuration !== undefined && mismatch.statusFieldId !== configuration.statusFieldNodeId) {
    context.addIssue({ code: 'custom', message: 'Provider mapping failure targets another Status field' })
    return
  }
  if (mismatch.reason === 'field-missing-or-not-single-select') {
    const expected = [{ reason: 'status-field-missing' as const, statusFieldId: mismatch.statusFieldId }]
    if (!sameMappingIssues(mapping.issues, expected)) {
      context.addIssue({ code: 'custom', message: 'mapping repair field disagrees with the Provider failure' })
    }
    return
  }
  if (configuration === undefined) {
    const uniqueStatuses = new Set<string>()
    const matches = mapping.issues.length === mismatch.missingRequiredStatusOptionIds.length
      && mapping.issues.every((issue, index) => {
        if (issue.reason !== 'status-option-missing'
          || issue.statusOptionId !== mismatch.missingRequiredStatusOptionIds[index]
          || uniqueStatuses.has(issue.status)) return false
        uniqueStatuses.add(issue.status)
        return true
      })
    if (!matches) {
      context.addIssue({ code: 'custom', message: 'mapping repair options disagree with the Provider failure' })
    }
    return
  }
  const statusByOptionId = new Map(STATUS_OPTION_FIELDS.map(([field, status]) => [
    configuration.statusOptionNodeIds[field],
    status,
  ] as const))
  const expected = mismatch.missingRequiredStatusOptionIds.flatMap((statusOptionId) => {
    const status = statusByOptionId.get(statusOptionId)
    return status === undefined ? [] : [{ reason: 'status-option-missing' as const, status, statusOptionId }]
  })
  if (!sameMappingIssues(mapping.issues, expected)) {
    context.addIssue({ code: 'custom', message: 'mapping repair options disagree with the current configuration' })
  }
}

function validateCurrentConfigurationEvidence(
  currentRevision: number,
  synchronizationRevision: number,
  mapping: Exclude<SakiGitHubMappingHealthProjection, { readonly state: 'unconfigured' }>,
  failure: SakiGitHubSynchronizationFailureProjection | undefined,
  scan: SakiGitHubScanStateProjection,
  context: z.RefinementCtx,
  configuration?: GitHubSynchronizationConfiguration,
): void {
  if (currentRevision !== synchronizationRevision) {
    context.addIssue({ code: 'custom', message: 'current configuration and synchronization revisions disagree' })
  }
  if (mapping.configurationRevision !== currentRevision) {
    context.addIssue({ code: 'custom', message: 'mapping does not describe the current configuration' })
  }
  if (failure !== undefined && failure.configurationRevision !== currentRevision) {
    context.addIssue({ code: 'custom', message: 'failure does not describe the current configuration' })
  }
  if (scan.state === 'in-flight' && scan.configurationRevision !== currentRevision) {
    context.addIssue({ code: 'custom', message: 'scan does not target the current configuration' })
  }
  if ((mapping.state === 'repair-required') !== mappingFailureRequiresRepair(failure)) {
    context.addIssue({ code: 'custom', message: 'mapping repair state disagrees with the current failure' })
  }
  validateMappingRepairEvidence(mapping, failure, configuration, context)
}

function validateFreshness(
  freshness: z.infer<typeof boardAvailableFreshnessSchema>,
  context: z.RefinementCtx,
  activePollIntervalMs?: number,
): void {
  const minimumStaleAt = safeTimestampAdd(
    freshness.confirmedAt,
    activePollIntervalMs ?? MIN_POLL_INTERVAL_MS,
  )
  const maximumStaleAt = safeTimestampAdd(
    freshness.confirmedAt,
    activePollIntervalMs ?? MAX_POLL_INTERVAL_MS,
  )
  if (freshness.staleAt < minimumStaleAt || freshness.staleAt > maximumStaleAt) {
    context.addIssue({ code: 'custom', message: 'Board staleness disagrees with its active polling interval' })
    return
  }
  if (freshness.ageMs > Number.MAX_SAFE_INTEGER - freshness.confirmedAt) {
    context.addIssue({ code: 'custom', message: 'Board age exceeds the safe timestamp range' })
    return
  }
  const staleAfterMs = freshness.staleAt - freshness.confirmedAt
  if (staleAfterMs === 0) return
  if ((freshness.state === 'fresh' && freshness.ageMs >= staleAfterMs)
    || (freshness.state === 'stale' && freshness.ageMs < staleAfterMs)) {
    context.addIssue({ code: 'custom', message: 'Board freshness state disagrees with its age' })
  }
}

function safeTimestampAdd(timestamp: number, duration: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, timestamp + duration)
}

function expectedConfigurationChangedFields(
  pending: GitHubSynchronizationConfiguration,
  active: GitHubSynchronizationConfiguration | undefined,
): readonly GitHubSynchronizationConfigurationField[] {
  return GITHUB_SYNCHRONIZATION_CONFIGURATION_FIELDS.filter(field => active === undefined
    || canonicalDigest('saki/github-synchronization-field/v1', pending[field])
      !== canonicalDigest('saki/github-synchronization-field/v1', active[field]))
}

const boardWorkItemWireSchema = z.object({
  id: boardWorkItemId,
  title: safeText,
  issueNumber: positiveInteger,
  url: safeUrl,
  issueState: z.enum(['open', 'closed']),
  status: sakiBoardStatusSchema,
  latestNonTerminalStatus: z.enum(['inbox', 'backlog', 'ready', 'in-progress', 'in-review']).nullable(),
  order: safeInteger,
  archived: z.boolean(),
  notInProject: z.boolean(),
  updatedAt: safeInteger,
  source: z.object({
    kind: z.literal('github-issue'),
    repositoryId: githubNodeId<GitHubRepositoryId>(),
    issueId: githubNodeId<SakiBoardWorkItemProjection['source']['issueId']>(),
    projectItemId: githubNodeId<NonNullable<SakiBoardWorkItemProjection['source']['projectItemId']>>().optional(),
    apiOrder: safeInteger.optional(),
  }).strict(),
  remoteFingerprint: boardRemoteFingerprint,
}).strict().superRefine((item, context) => {
  const expectedId = `work-item-${canonicalDigest('saki/board-work-item/v1', {
    repositoryId: item.source.repositoryId,
    issueId: item.source.issueId,
  })}`
  if (item.id !== expectedId) {
    context.addIssue({ code: 'custom', message: 'Work Item id disagrees with its GitHub Issue identity' })
  }
  if (item.notInProject) {
    if (item.source.projectItemId !== undefined || item.source.apiOrder !== undefined) {
      context.addIssue({ code: 'custom', message: 'non-Project item contains Project membership' })
    }
    if (item.status !== 'inbox' || item.archived) {
      context.addIssue({ code: 'custom', message: 'non-Project item must be active Inbox work' })
    }
    if (item.issueState !== 'open') {
      context.addIssue({ code: 'custom', message: 'non-Project Inbox item must be an open Issue' })
    }
  } else if (item.source.projectItemId === undefined || item.source.apiOrder === undefined) {
    context.addIssue({ code: 'custom', message: 'Project item is missing complete Project membership' })
  } else if (item.order !== item.source.apiOrder) {
    context.addIssue({ code: 'custom', message: 'Project item order disagrees with its GitHub API position' })
  }
  if (item.archived && item.status !== 'canceled') {
    context.addIssue({ code: 'custom', message: 'archived Project item must be canceled' })
  }
  if (item.status !== 'done' && item.status !== 'canceled'
    && item.latestNonTerminalStatus !== item.status) {
    context.addIssue({ code: 'custom', message: 'non-terminal Work Item must remember its current Status' })
  }
}) satisfies z.ZodType<SakiBoardWorkItemProjection>

const confirmedBoardSchema = z.object({
  generation: positiveRevision,
  configurationRevision: positiveRevision,
  repository: z.object({
    id: githubNodeId<GitHubRepositoryId>(),
    nameWithOwner: z.string().regex(/^[^/\u0000-\u001f\u007f]+\/[^/\u0000-\u001f\u007f]+$/u).max(201),
    url: safeUrl,
  }).strict(),
  project: z.object({
    id: githubNodeId<GitHubProjectId>(),
    title: safeText,
    url: safeUrl,
  }).strict(),
  items: boundedArray(boardWorkItemWireSchema, 0, SAKI_BOARD_WORK_ITEM_LIMIT),
}).strict().superRefine((board, context) => {
  if (new Set(board.items.map(item => item.id)).size !== board.items.length) {
    context.addIssue({ code: 'custom', message: 'confirmed Board repeats Work Item ids' })
  }
  if (new Set(board.items.map(item => item.source.issueId)).size !== board.items.length) {
    context.addIssue({ code: 'custom', message: 'confirmed Board repeats GitHub Issue identities' })
  }
  if (new Set(board.items.map(item => item.issueNumber)).size !== board.items.length) {
    context.addIssue({ code: 'custom', message: 'confirmed Board repeats GitHub Issue numbers' })
  }
  const joinedProjectItemIds = board.items.flatMap(item => item.source.projectItemId === undefined
    ? []
    : [item.source.projectItemId])
  if (new Set(joinedProjectItemIds).size !== joinedProjectItemIds.length) {
    context.addIssue({ code: 'custom', message: 'confirmed Board repeats GitHub Project item identities' })
  }
  if (board.items.some(item => item.source.repositoryId !== board.repository.id)) {
    context.addIssue({ code: 'custom', message: 'confirmed Board contains another Repository' })
  }
  let previousOrder = -1
  let reachedUnjoinedItems = false
  for (const item of board.items) {
    if (item.order <= previousOrder) {
      context.addIssue({ code: 'custom', message: 'confirmed Board Work Item order is not strictly increasing' })
      break
    }
    if (item.notInProject) reachedUnjoinedItems = true
    else if (reachedUnjoinedItems) {
      context.addIssue({ code: 'custom', message: 'joined Project item follows an unjoined Inbox item' })
      break
    }
    previousOrder = item.order
  }
})

const workItemMutationStageKindSchema = z.enum([
  'issue-create',
  'project-item-add',
  'project-item-status-set',
  'project-item-position-set',
  'issue-state-set',
])
const workItemRecoveryActionSchema = z.union([
  z.object({ kind: z.literal('inspect-before-retry') }).strict(),
  z.object({ kind: z.literal('resume-intent') }).strict(),
  z.object({ kind: z.literal('repair-mapping'), reason: safeText }).strict(),
])

/** Strict browser-safe state layered over one complete confirmed Board. */
export const sakiBoardMutationOverlaySchema: z.ZodType<SakiBoardMutationOverlayProjection> = z.union([
  z.object({
    state: z.literal('optimistic'),
    intentId,
    type: z.literal('create-work-item'),
    title: projectTitle,
    targetStatus: z.literal('inbox'),
  }).strict(),
  z.object({
    state: z.literal('optimistic'),
    intentId,
    type: z.literal('move-work-item'),
    workItemId: boardWorkItemId,
    targetStatus: sakiBoardStatusSchema,
    position: sakiMoveWorkItemPositionSchema.optional(),
  }).strict(),
  z.object({
    state: z.literal('targeted-confirmed'),
    intentId,
    type: z.enum(['create-work-item', 'move-work-item']),
    workItem: boardWorkItemWireSchema,
    confirmedAt: safeInteger,
  }).strict(),
  z.object({
    state: z.literal('conflict'),
    intentId,
    type: z.enum(['create-work-item', 'move-work-item']),
    reason: z.enum(['expected-revision', 'stale-remote', 'mapping-repair-required']),
    workItem: boardWorkItemWireSchema.optional(),
    confirmedAt: safeInteger.optional(),
  }).strict(),
  z.object({
    state: z.literal('partial-failure'),
    intentId,
    type: z.enum(['create-work-item', 'move-work-item']),
    workItemId: boardWorkItemId.optional(),
    stage: workItemMutationStageKindSchema,
    recoveryAction: workItemRecoveryActionSchema,
  }).strict(),
  z.object({
    state: z.literal('reconciliation-required'),
    intentId,
    type: z.enum(['create-work-item', 'move-work-item']),
    workItemId: boardWorkItemId.optional(),
    stage: workItemMutationStageKindSchema,
    reason: z.enum(['effect-unknown', 'evidence-conflict', 'marker-ambiguous']),
  }).strict(),
  z.object({
    state: z.literal('repair-required'),
    workItemId: boardWorkItemId,
    reason: z.enum(['external-close', 'external-reopen']),
    action: z.literal('move-with-actor'),
    suggestedStatus: sakiBoardStatusSchema,
  }).strict(),
])

const boardProjectionSharedShape = {
  type: z.literal('board'),
  projectId,
  synchronizationRevision: revision,
  effectiveMutationAvailability: sakiBoardMutationAvailabilitySchema,
  mutationOverlays: boundedArray(sakiBoardMutationOverlaySchema, 0, SAKI_BOARD_WORK_ITEM_LIMIT),
} as const

const unconfiguredBoardProjectionSchema = z.object({
  ...boardProjectionSharedShape,
  state: z.literal('unconfigured'),
  synchronizationRevision: z.literal(0),
  mapping: z.object({ state: z.literal('unconfigured') }).strict(),
  freshness: boardUnavailableFreshnessSchema,
  scan: githubIdleScanSchema,
}).strict().superRefine((projection, context) => {
  validateMutationAvailability(
    projection.effectiveMutationAvailability,
    expectedMutationUnavailableReasons('unconfigured', 'unconfigured', false),
    context,
  )
})
const awaitingBoardProjectionSchema = z.object({
  ...boardProjectionSharedShape,
  state: z.literal('awaiting-first-checkpoint'),
  synchronizationRevision: positiveRevision,
  failure: githubSynchronizationFailureProjectionSchema.optional(),
  mapping: githubConfiguredMappingBeforeCheckpointSchema,
  freshness: boardUnavailableFreshnessSchema,
  scan: githubScanStateSchema,
}).strict().superRefine((projection, context) => {
  const currentRevision = projection.mapping.configurationRevision
  validateCurrentConfigurationEvidence(
    currentRevision,
    projection.synchronizationRevision,
    projection.mapping,
    projection.failure,
    projection.scan,
    context,
  )
  validateMutationAvailability(
    projection.effectiveMutationAvailability,
    expectedMutationUnavailableReasons('not-activated', projection.mapping.state, false),
    context,
  )
})
const confirmedBoardProjectionSchema = z.object({
  ...boardProjectionSharedShape,
  state: z.literal('confirmed'),
  synchronizationRevision: positiveRevision,
  confirmed: confirmedBoardSchema,
  checkpoint: githubSyncCheckpointSchema,
  failure: githubSynchronizationFailureProjectionSchema.optional(),
  mapping: githubMappingHealthSchema,
  freshness: boardAvailableFreshnessSchema,
  scan: githubScanStateSchema,
}).strict().superRefine((projection, context) => {
  if (projection.confirmed.generation !== projection.checkpoint.generation
    || projection.confirmed.configurationRevision !== projection.checkpoint.configurationRevision) {
    context.addIssue({ code: 'custom', message: 'confirmed Board and checkpoint revisions disagree' })
  }
  if (projection.synchronizationRevision < projection.checkpoint.configurationRevision) {
    context.addIssue({ code: 'custom', message: 'Board synchronization revision precedes its checkpoint' })
  }
  if (projection.confirmed.repository.id !== projection.checkpoint.repositoryId
    || projection.confirmed.project.id !== projection.checkpoint.projectId) {
    context.addIssue({ code: 'custom', message: 'confirmed Board and checkpoint targets disagree' })
  }
  if (projection.mapping.state === 'unconfigured') {
    context.addIssue({ code: 'custom', message: 'confirmed Board has no configured mapping' })
    return
  }
  const currentRevision = projection.mapping.configurationRevision
  validateCurrentConfigurationEvidence(
    currentRevision,
    projection.synchronizationRevision,
    projection.mapping,
    projection.failure,
    projection.scan,
    context,
  )
  if (currentRevision < projection.checkpoint.configurationRevision) {
    context.addIssue({ code: 'custom', message: 'current mapping revision precedes the confirmed checkpoint' })
  }
  if (currentRevision === projection.checkpoint.configurationRevision
    && projection.failure?.failure.kind === 'provider'
    && projection.failure.failure.failure.code === 'mapping-mismatch'
    && projection.failure.failure.failure.statusFieldId !== projection.checkpoint.statusFieldId) {
    context.addIssue({ code: 'custom', message: 'current mapping failure targets another checkpoint Status field' })
  }
  if (currentRevision === projection.checkpoint.configurationRevision
    && projection.mapping.state === 'repair-required'
    && projection.mapping.issues.some(issue => issue.reason === 'status-field-missing'
      && issue.statusFieldId !== projection.checkpoint.statusFieldId)) {
    context.addIssue({ code: 'custom', message: 'current mapping repair targets another checkpoint Status field' })
  }
  if (projection.mapping.state === 'valid') {
    if (currentRevision !== projection.checkpoint.configurationRevision) {
      context.addIssue({ code: 'custom', message: 'valid mapping and checkpoint revisions disagree' })
    }
    if (projection.mapping.validatedAt !== projection.checkpoint.confirmedAt) {
      context.addIssue({ code: 'custom', message: 'mapping validation and checkpoint confirmation disagree' })
    }
  } else if (projection.mapping.state === 'revalidation-required'
    && currentRevision === projection.checkpoint.configurationRevision) {
    context.addIssue({ code: 'custom', message: 'mapping revalidation has no newer configuration' })
  }
  if (projection.freshness.confirmedAt !== projection.checkpoint.confirmedAt) {
    context.addIssue({ code: 'custom', message: 'Board freshness and checkpoint confirmation disagree' })
  }
  validateFreshness(projection.freshness, context)
  validateMutationAvailability(
    projection.effectiveMutationAvailability,
    expectedMutationUnavailableReasons(
      currentRevision === projection.checkpoint.configurationRevision ? 'activated' : 'not-activated',
      projection.mapping.state,
      true,
    ),
    context,
  )
})

/** Complete Board Projection schema with atomic checkpoint and mapping evidence. */
export const sakiBoardProjectionSchema: z.ZodType<SakiBoardProjection> = z.discriminatedUnion('state', [
  unconfiguredBoardProjectionSchema,
  awaitingBoardProjectionSchema,
  confirmedBoardProjectionSchema,
])

const sakiAgentRunSessionId = brandedId<SakiAgentRunProjection['sessionId']>('session')
const agentPresetId = z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9-]*$/u)
const safeAgentDisplayText = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value.isWellFormed() && !/[\u0000\u007f]/u.test(value))

const sakiAgentRunProjectionBaseShape = {
  id: sakiAgentRunIdSchema,
  revision,
  assignmentId,
  workSessionId: sakiWorkSessionIdSchema,
  sessionId: sakiAgentRunSessionId,
  source: z.object({
    kind: z.literal('manual-give-to-agent'),
    intentId,
    projectId,
    workItemId: boardWorkItemId,
  }).strict(),
  profile: z.object({
    id: sakiAgentProfileIdSchema,
    version: positiveRevision,
    agentPresetId,
  }).strict(),
  model: z.object({
    provider: safeAgentDisplayText(200),
    model: safeAgentDisplayText(200),
  }).strict(),
  createdAt: safeInteger,
  updatedAt: safeInteger,
} as const

const currentAgentRunProjectionSchema = z.object({
  ...sakiAgentRunProjectionBaseShape,
  state: z.enum(['allocated', 'starting', 'running']),
  recovery: z.object({ state: z.literal('resumable') }).strict(),
}).strict().refine(value => value.updatedAt >= value.createdAt, 'Agent Run timestamps are not monotonic')

const canceledAgentRunProjectionSchema = z.object({
  ...sakiAgentRunProjectionBaseShape,
  state: z.literal('canceled'),
  recovery: z.object({
    state: z.literal('terminal'),
    reason: z.literal('authority-revoked'),
  }).strict(),
}).strict().refine(value => value.updatedAt >= value.createdAt, 'Agent Run timestamps are not monotonic')

const reconciliationAgentRunProjectionSchema = z.object({
  ...sakiAgentRunProjectionBaseShape,
  state: z.literal('reconciliation-required'),
  recovery: z.object({
    state: z.literal('required'),
    reason: z.enum(['effect-unknown', 'evidence-conflict', 'protocol']),
  }).strict(),
}).strict().refine(value => value.updatedAt >= value.createdAt, 'Agent Run timestamps are not monotonic')

const recentAgentRunProjectionSchema = z.union([
  canceledAgentRunProjectionSchema,
  reconciliationAgentRunProjectionSchema,
])

/** Browser-safe current or recent manual Agent Run schema. */
export const sakiAgentRunProjectionSchema = z.union([
  currentAgentRunProjectionSchema,
  recentAgentRunProjectionSchema,
]) satisfies z.ZodType<SakiAgentRunProjection>

/** Strict assigned Work Item detail schema without Host or credential evidence. */
export const sakiWorkItemDetailProjectionSchema = z.object({
  type: z.literal('work-item-detail'),
  projectId,
  workItemId: boardWorkItemId,
  definition: z.object({
    title: safeAgentDisplayText(4_096),
    url: safeUrl,
    number: positiveInteger,
    status: sakiBoardStatusSchema,
    intendedOutcome: safeAgentDisplayText(32_768),
    acceptanceCriteria: boundedArray(safeAgentDisplayText(4_096), 1, 128),
    blockage: boundedArray(safeAgentDisplayText(4_096), 0, 128),
  }).strict(),
  assignment: z.object({
    id: assignmentId,
    revision,
    state: z.enum(['assigned', 'active', 'canceled', 'reconciliation-required']),
    primaryWorkSessionId: sakiWorkSessionIdSchema,
    createdAt: safeInteger,
    updatedAt: safeInteger,
  }).strict(),
  primaryWorkSession: z.object({
    id: sakiWorkSessionIdSchema,
    revision,
    state: z.enum(['open', 'canceled', 'reconciliation-required']),
    createdAt: safeInteger,
    updatedAt: safeInteger,
  }).strict(),
  currentAgentRun: currentAgentRunProjectionSchema.optional(),
  recentAgentRuns: boundedArray(recentAgentRunProjectionSchema, 0, 32),
}).strict().superRefine((projection, context) => {
  if (projection.assignment.updatedAt < projection.assignment.createdAt) {
    context.addIssue({ code: 'custom', message: 'Assignment timestamps are not monotonic', path: ['assignment'] })
  }
  if (projection.primaryWorkSession.updatedAt < projection.primaryWorkSession.createdAt) {
    context.addIssue({
      code: 'custom',
      message: 'Work Session timestamps are not monotonic',
      path: ['primaryWorkSession'],
    })
  }
  if (projection.assignment.primaryWorkSessionId !== projection.primaryWorkSession.id) {
    context.addIssue({
      code: 'custom',
      message: 'Assignment disagrees with its primary Work Session',
      path: ['primaryWorkSession'],
    })
  }
  const runs = [
    ...(projection.currentAgentRun === undefined ? [] : [projection.currentAgentRun]),
    ...projection.recentAgentRuns,
  ]
  if (runs.length > 32 || new Set(runs.map(run => run.id)).size !== runs.length) {
    context.addIssue({ code: 'custom', message: 'Work Item detail repeats or exceeds Agent Runs', path: ['recentAgentRuns'] })
  }
  for (const [index, run] of runs.entries()) {
    if (run.source.projectId !== projection.projectId || run.source.workItemId !== projection.workItemId) {
      context.addIssue({
        code: 'custom',
        message: 'Agent Run belongs to another Work Item',
        path: index === 0 && projection.currentAgentRun !== undefined
          ? ['currentAgentRun', 'source']
          : ['recentAgentRuns', index - (projection.currentAgentRun === undefined ? 0 : 1), 'source'],
      })
    }
  }
  if (projection.currentAgentRun !== undefined
    && (projection.currentAgentRun.assignmentId !== projection.assignment.id
      || projection.currentAgentRun.workSessionId !== projection.primaryWorkSession.id)) {
    context.addIssue({
      code: 'custom',
      message: 'Current Agent Run disagrees with the active Assignment or primary Work Session',
      path: ['currentAgentRun'],
    })
  }
}) satisfies z.ZodType<SakiWorkItemDetailProjection>

const githubSynchronizationActiveSchema = z.object({
  revision: positiveRevision,
  configuration: githubSynchronizationConfigurationSchema,
  activatedAt: z.number().int().nonnegative(),
}).strict()
const githubSynchronizationPendingSchema = z.object({
  revision: positiveRevision,
  changedFields: z.array(githubSynchronizationConfigurationField).min(1)
    .refine(fields => new Set(fields).size === fields.length),
  state: z.enum(['saved', 'activating', 'activation-failed']),
  configuration: githubSynchronizationConfigurationSchema,
  savedAt: z.number().int().nonnegative(),
}).strict()

/** Project Settings Projection schema with safe GitHub references and activation state. */
export const sakiProjectSettingsProjectionSchema = z.object({
  type: z.literal('project-settings'),
  projectId,
  synchronization: z.object({
    revision,
    state: z.enum(['unconfigured', 'saved', 'activating', 'activated', 'activation-failed']),
    active: githubSynchronizationActiveSchema.optional(),
    pending: githubSynchronizationPendingSchema.optional(),
    checkpoint: githubSyncCheckpointSchema.optional(),
    mapping: githubMappingHealthSchema,
    failure: githubSynchronizationFailureProjectionSchema.optional(),
    freshness: boardFreshnessSchema,
    scan: githubScanStateSchema,
    effectiveMutationAvailability: sakiBoardMutationAvailabilitySchema,
  }).strict().superRefine((synchronization, context) => {
    const { active, checkpoint, failure, freshness, mapping, pending, scan, state } = synchronization
    if (state === 'unconfigured' && (synchronization.revision !== 0
      || active !== undefined
      || pending !== undefined
      || checkpoint !== undefined
      || failure !== undefined
      || mapping.state !== 'unconfigured'
      || freshness.state !== 'unavailable'
      || scan.state !== 'idle')) {
      context.addIssue({ code: 'custom', message: 'unconfigured synchronization contains configuration state' })
      return
    }
    if (state === 'unconfigured') {
      validateMutationAvailability(
        synchronization.effectiveMutationAvailability,
        expectedMutationUnavailableReasons('unconfigured', 'unconfigured', false),
        context,
      )
      return
    }
    if (synchronization.revision === 0) {
      context.addIssue({ code: 'custom', message: 'configured synchronization must have a positive revision' })
    }
    if (state === 'activated' && (active === undefined || pending !== undefined)) {
      context.addIssue({ code: 'custom', message: 'activated synchronization has inconsistent configuration state' })
      return
    }
    if (state !== 'activated' && (pending === undefined || pending.state !== state)) {
      context.addIssue({ code: 'custom', message: 'pending synchronization state is inconsistent' })
    }
    if ((active?.revision ?? 0) > synchronization.revision
      || (pending?.revision ?? 0) > synchronization.revision
      || (active !== undefined && pending !== undefined && pending.revision <= active.revision)) {
      context.addIssue({ code: 'custom', message: 'configuration revision sequence is inconsistent' })
    }
    const currentRevision = pending?.revision ?? active?.revision
    if (currentRevision === undefined || mapping.state === 'unconfigured') {
      context.addIssue({ code: 'custom', message: 'configured synchronization has no current configuration mapping' })
      return
    }
    validateCurrentConfigurationEvidence(
      currentRevision,
      synchronization.revision,
      mapping,
      failure,
      scan,
      context,
      pending?.configuration ?? active?.configuration,
    )
    if (pending !== undefined) {
      const expectedChangedFields = expectedConfigurationChangedFields(pending.configuration, active?.configuration)
      if (pending.changedFields.length !== expectedChangedFields.length
        || pending.changedFields.some((field, index) => field !== expectedChangedFields[index])) {
        context.addIssue({ code: 'custom', message: 'pending changed fields disagree with its configurations' })
      }
    }
    if (state === 'activating' && scan.state !== 'in-flight') {
      context.addIssue({ code: 'custom', message: 'activating configuration has no matching in-flight scan' })
    }
    if (pending !== undefined && scan.state === 'in-flight' && pending.state !== 'activating') {
      context.addIssue({ code: 'custom', message: 'pending scan does not have activating configuration state' })
    }
    if (state === 'activation-failed' && failure === undefined) {
      context.addIssue({ code: 'custom', message: 'failed activation has no current failure' })
    }
    if (state === 'saved' && (failure !== undefined || scan.state === 'in-flight')) {
      context.addIssue({ code: 'custom', message: 'saved configuration contains activation attempt evidence' })
    }
    validateMutationAvailability(
      synchronization.effectiveMutationAvailability,
      expectedMutationUnavailableReasons(
        state === 'activated' ? 'activated' : 'not-activated',
        mapping.state,
        checkpoint !== undefined,
      ),
      context,
    )
    if (checkpoint === undefined) {
      if (active !== undefined) {
        context.addIssue({ code: 'custom', message: 'active synchronization is missing its checkpoint' })
      }
      if (mapping.state === 'valid' || freshness.state !== 'unavailable') {
        context.addIssue({ code: 'custom', message: 'synchronization evidence requires a checkpoint' })
      }
      return
    }
    if (active === undefined
      || checkpoint.configurationRevision !== active.revision
      || checkpoint.installationId !== active.configuration.githubInstallationId
      || checkpoint.repositoryId !== active.configuration.repositoryNodeId
      || checkpoint.projectId !== active.configuration.projectNodeId
      || checkpoint.statusFieldId !== active.configuration.statusFieldNodeId) {
      context.addIssue({ code: 'custom', message: 'checkpoint and active synchronization disagree' })
    }
    if (freshness.state === 'unavailable') {
      context.addIssue({ code: 'custom', message: 'synchronization freshness and checkpoint disagree' })
      return
    }
    if (freshness.confirmedAt !== checkpoint.confirmedAt) {
      context.addIssue({ code: 'custom', message: 'synchronization freshness and checkpoint disagree' })
    }
    validateFreshness(freshness, context, active?.configuration.activePollIntervalMs)
    if (mapping.state === 'valid') {
      if (mapping.configurationRevision !== checkpoint.configurationRevision) {
        context.addIssue({ code: 'custom', message: 'valid mapping and checkpoint revisions disagree' })
      }
      if (mapping.validatedAt !== checkpoint.confirmedAt) {
        context.addIssue({ code: 'custom', message: 'mapping validation and checkpoint confirmation disagree' })
      }
    }
  }),
}).strict().transform((value): SakiProjectSettingsProjection => {
  const { active, pending, ...synchronization } = value.synchronization
  return {
    ...value,
    synchronization: {
      ...synchronization,
      ...(active === undefined ? {} : { active }),
      ...(pending === undefined ? {} : { pending }),
    },
  }
}) satisfies z.ZodType<SakiProjectSettingsProjection>

const inspectQueryFailureSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(['denied', 'unavailable']),
}).strict()
const projectIndexFailureSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(['denied', 'unavailable']),
}).strict()
const developmentWorkspaceFailureSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(['denied', 'unavailable', 'stale', 'not-found']),
}).strict()
const boundProjectReadFailureSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(['denied', 'unavailable', 'stale', 'not-found', 'binding-unavailable']),
}).strict()
const projectSettingsFailureSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(['denied', 'unavailable', 'not-found']),
}).strict()
const boardFailureSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(['denied', 'unavailable', 'not-found']),
}).strict()

/** Exact result schema for an inspection query. */
export const sakiInspectProjectSelectionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projection: sakiProjectSelectionInspectionProjectionSchema }).strict(),
  inspectQueryFailureSchema,
]) satisfies z.ZodType<SakiQueryResult<'inspect-project-selection'>>

/** Exact result schema for a Project-index query. */
export const sakiProjectIndexResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projection: sakiProjectIndexProjectionSchema }).strict(),
  projectIndexFailureSchema,
]) satisfies z.ZodType<SakiQueryResult<'project-index'>>

/** Exact result schema for a Development-Workspace query. */
export const sakiDevelopmentWorkspaceResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projection: sakiDevelopmentWorkspaceProjectionSchema }).strict(),
  developmentWorkspaceFailureSchema,
]) satisfies z.ZodType<SakiQueryResult<'development-workspace'>>

/** Exact result schema for a Project-status query. */
export const sakiProjectChangesResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projection: sakiProjectChangesProjectionSchema }).strict(),
  boundProjectReadFailureSchema,
]) satisfies z.ZodType<SakiQueryResult<'project-changes'>>

/** Exact result schema for a Project-Diff query. */
export const sakiProjectDiffResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projection: sakiProjectDiffProjectionSchema }).strict(),
  boundProjectReadFailureSchema,
]) satisfies z.ZodType<SakiQueryResult<'project-diff'>>

/** Exact result schema for a Project Settings query. */
export const sakiProjectSettingsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projection: sakiProjectSettingsProjectionSchema }).strict(),
  projectSettingsFailureSchema,
]) satisfies z.ZodType<SakiQueryResult<'project-settings'>>

/** Exact result schema for a Board query. */
export const sakiBoardResultSchema: z.ZodType<SakiQueryResult<'board'>> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projection: sakiBoardProjectionSchema }).strict(),
  boardFailureSchema,
])

/** Union schema retained for callers that intentionally handle every query kind. */
export const sakiQueryResultSchema = z.union([
  sakiInspectProjectSelectionResultSchema,
  sakiProjectIndexResultSchema,
  sakiDevelopmentWorkspaceResultSchema,
  sakiProjectChangesResultSchema,
  sakiProjectDiffResultSchema,
  sakiProjectSettingsResultSchema,
  sakiBoardResultSchema,
])

const receiptIdentity = { id: receiptId, intentId } as const
const preparedReceiptSchema = z.object({
  ...receiptIdentity,
  state: z.literal('prepared'),
}).strict().refine(receipt => receipt.id === receipt.intentId.replace(/^intent-/u, 'receipt-'))
const confirmedReceiptSchema = z.object({
  ...receiptIdentity,
  state: z.literal('confirmed'),
  projectId,
  resourceBindingId: bindingId,
  registryRevision: z.number().int().positive(),
}).strict().refine(receipt => receipt.id === receipt.intentId.replace(/^intent-/u, 'receipt-'))
const conflictReceiptSchema = z.object({
  ...receiptIdentity,
  state: z.literal('conflict'),
  reason: z.enum(['expected-revision', 'duplicate-binding']),
}).strict().refine(receipt => receipt.id === receipt.intentId.replace(/^intent-/u, 'receipt-'))
const failureReceiptSchema = z.object({
  ...receiptIdentity,
  state: z.literal('failure'),
  reason: z.literal('authority'),
}).strict().refine(receipt => receipt.id === receipt.intentId.replace(/^intent-/u, 'receipt-'))
const reconciliationReceiptSchema = z.object({
  ...receiptIdentity,
  state: z.literal('reconciliation-required'),
  reason: z.enum(['workspace', 'observation']),
}).strict().refine(receipt => receipt.id === receipt.intentId.replace(/^intent-/u, 'receipt-'))
const deniedIntentResultSchema = z.object({ ok: z.literal(false), reason: z.literal('denied') }).strict()
const unavailableIntentResultSchema = z.object({ ok: z.literal(false), reason: z.literal('unavailable') }).strict()
const preparedIntentResultSchema = z.object({
  ok: z.literal(false),
  reason: z.literal('unavailable'),
  receipt: preparedReceiptSchema,
}).strict()
const plainConflictIntentResultSchema = z.object({ ok: z.literal(false), reason: z.literal('conflict') }).strict()
const authorityFailureIntentResultSchema = z.object({
  ok: z.literal(false),
  reason: z.literal('failure'),
  receipt: failureReceiptSchema,
}).strict()

/** Development Project registration business-result schema. */
export const sakiRegisterDevelopmentProjectResultSchema = z.union([
  z.object({ ok: z.literal(true), receipt: confirmedReceiptSchema }).strict(),
  deniedIntentResultSchema,
  unavailableIntentResultSchema,
  preparedIntentResultSchema,
  plainConflictIntentResultSchema,
  z.object({
    ok: z.literal(false),
    reason: z.literal('conflict'),
    receipt: conflictReceiptSchema,
  }).strict(),
  authorityFailureIntentResultSchema,
  z.object({
    ok: z.literal(false),
    reason: z.literal('reconciliation-required'),
    receipt: reconciliationReceiptSchema,
  }).strict(),
]) satisfies z.ZodType<SakiIntentReceipt>

const savedGitHubSynchronizationReceiptSchema = z.object({
  ...receiptIdentity,
  state: z.literal('saved'),
  projectId,
  synchronizationRevision: z.number().int().positive(),
  candidateRevision: z.number().int().positive(),
}).strict().superRefine((receipt, context) => {
  if (receipt.id !== receipt.intentId.replace(/^intent-/u, 'receipt-')) {
    context.addIssue({ code: 'custom', message: 'receipt id disagrees with Intent id' })
  }
  if (receipt.candidateRevision !== receipt.synchronizationRevision) {
    context.addIssue({ code: 'custom', message: 'saved configuration revisions disagree' })
  }
})
const githubSynchronizationConflictReceiptSchema = z.object({
  ...receiptIdentity,
  state: z.literal('conflict'),
  reason: z.enum([
    'expected-revision',
    'project-not-found',
    'configuration-incomplete',
    'configuration-unchanged',
  ]),
}).strict().refine(receipt => receipt.id === receipt.intentId.replace(/^intent-/u, 'receipt-'))

/** GitHub synchronization configuration business-result schema. */
export const sakiConfigureGitHubSynchronizationResultSchema = z.union([
  z.object({ ok: z.literal(true), receipt: savedGitHubSynchronizationReceiptSchema }).strict(),
  deniedIntentResultSchema,
  unavailableIntentResultSchema,
  preparedIntentResultSchema,
  plainConflictIntentResultSchema,
  z.object({
    ok: z.literal(false),
    reason: z.literal('conflict'),
    receipt: githubSynchronizationConflictReceiptSchema,
  }).strict(),
  authorityFailureIntentResultSchema,
]) satisfies z.ZodType<SakiIntentReceipt<'configure-github-synchronization'>>

const gitOperationConflictReason = z.enum([
  'expected-evidence',
  'invalid-selection',
  'source-conflict',
  'protocol',
])
const gitOperationFailedReason = z.enum([
  'binding-stale',
  'observation-stale',
  'invalid-selection',
  'unsupported-state',
])

function validateIntentResultReceiptIdentity(
  result: {
    readonly ok: boolean
    readonly receipt?: { readonly id: string; readonly intentId: string } | undefined
  },
  context: z.RefinementCtx,
): void {
  const receipt = result.receipt
  if (receipt === undefined) return
  if (receipt.id !== receipt.intentId.replace(/^intent-/u, 'receipt-')) {
    context.addIssue({ code: 'custom', message: 'receipt id disagrees with Intent id', path: ['receipt', 'id'] })
  }
}

function createSharedIntentResultSchemas<
  S extends z.ZodType,
  N extends z.ZodType,
  C extends z.ZodType,
  R extends z.ZodType,
>(succeeded: S, nonterminal: N, conflict: C, reconciliationRequired: R) {
  return {
    prefix: [
      z.object({ ok: z.literal(true), receipt: succeeded }).strict(),
      deniedIntentResultSchema,
      unavailableIntentResultSchema,
      z.object({ ok: z.literal(false), reason: z.literal('unavailable'), receipt: nonterminal }).strict(),
      plainConflictIntentResultSchema,
      z.object({ ok: z.literal(false), reason: z.literal('conflict'), receipt: conflict }).strict(),
    ] as const,
    reconciliationRequired: z.object({
      ok: z.literal(false),
      reason: z.literal('reconciliation-required'),
      receipt: reconciliationRequired,
    }).strict(),
  } as const
}

function createGitOperationResultSchema<
  T extends 'stage-files' | 'unstage-files' | 'create-commit',
  H extends 'stage-files' | 'unstage-files' | 'commit',
  R extends z.ZodType,
>(intentType: T, hostType: H, successfulResult: R) {
  const base = {
    ...receiptIdentity,
    type: z.literal(intentType),
    projectId,
  } as const
  const operationBase = {
    id: hostOperationIdSchema,
    type: z.literal(hostType),
    revision,
  } as const
  const prepared = z.object({ ...base, state: z.literal('prepared') }).strict()
  const admissionReserved = z.object({ ...base, state: z.literal('admission-reserved') }).strict()
  const hostPrepared = z.object({
    ...base,
    state: z.literal('host-prepared'),
    operation: z.object({ ...operationBase, state: z.literal('prepared') }).strict(),
  }).strict()
  const accepted = z.object({
    ...base,
    state: z.literal('accepted'),
    operation: z.object({
      ...operationBase,
      state: z.enum(['accepted', 'planning', 'publishing']),
    }).strict(),
  }).strict()
  const succeeded = z.object({
    ...base,
    state: z.literal('succeeded'),
    operation: z.object({ ...operationBase, state: z.literal('succeeded') }).strict(),
    result: successfulResult,
  }).strict()
  const conflict = z.object({
    ...base,
    state: z.literal('conflict'),
    reason: gitOperationConflictReason,
    operation: z.object({ ...operationBase, state: z.literal('prepared') }).strict().optional(),
  }).strict().transform((value) => {
    const { operation: currentOperation, ...receipt } = value
    return { ...receipt, ...(currentOperation === undefined ? {} : { operation: currentOperation }) }
  })
  const failed = z.object({
    ...base,
    state: z.literal('failed'),
    reason: gitOperationFailedReason,
    operation: z.object({ ...operationBase, state: z.literal('failed') }).strict(),
  }).strict()
  const canceled = z.object({
    ...base,
    state: z.literal('canceled'),
    reason: z.enum(['source-canceled', 'authority-revoked']),
    operation: z.object({ ...operationBase, state: z.literal('canceled') }).strict().optional(),
  }).strict().transform((value) => {
    const { operation, ...receipt } = value
    return { ...receipt, ...(operation === undefined ? {} : { operation }) }
  })
  const reconciliationRequired = z.object({
    ...base,
    state: z.literal('reconciliation-required'),
    reason: z.enum(['effect-unknown', 'evidence-conflict']),
    operation: z.object({ ...operationBase, state: z.literal('reconciliation-required') }).strict(),
  }).strict()
  const nonterminal = z.union([prepared, admissionReserved, hostPrepared, accepted])
  const sharedResults = createSharedIntentResultSchemas(
    succeeded,
    nonterminal,
    conflict,
    reconciliationRequired,
  )
  return z.union([
    ...sharedResults.prefix,
    z.object({ ok: z.literal(false), reason: z.literal('failure'), receipt: failed }).strict(),
    z.object({ ok: z.literal(false), reason: z.literal('canceled'), receipt: canceled }).strict(),
    sharedResults.reconciliationRequired,
  ]).superRefine(validateIntentResultReceiptIdentity)
}

/** StageFiles business-result schema with a safe Host Operation Projection. */
export const sakiStageFilesResultSchema = createGitOperationResultSchema(
  'stage-files',
  'stage-files',
  stageFilesHostOperationResultSchema,
) satisfies z.ZodType<SakiGitOperationIntentReceipt<'stage-files'>>

/** UnstageFiles business-result schema with a safe Host Operation Projection. */
export const sakiUnstageFilesResultSchema = createGitOperationResultSchema(
  'unstage-files',
  'unstage-files',
  unstageFilesHostOperationResultSchema,
) satisfies z.ZodType<SakiGitOperationIntentReceipt<'unstage-files'>>

/** CreateCommit business-result schema with hook-free Commit evidence. */
export const sakiCreateCommitResultSchema = createGitOperationResultSchema(
  'create-commit',
  'commit',
  commitHostOperationResultSchema,
) satisfies z.ZodType<SakiGitOperationIntentReceipt<'create-commit'>>

function createWorkItemResultSchema<T extends 'create-work-item' | 'move-work-item'>(intentType: T) {
  const base = {
    ...receiptIdentity,
    type: z.literal(intentType),
    projectId,
  } as const
  const prepared = z.object({
    ...base,
    state: z.literal('prepared'),
    workItemId: boardWorkItemId.optional(),
  }).strict()
  const running = z.object({
    ...base,
    state: z.literal('running'),
    workItemId: boardWorkItemId.optional(),
  }).strict()
  const partialFailure = z.object({
    ...base,
    state: z.literal('partial-failure'),
    workItemId: boardWorkItemId.optional(),
    stage: workItemMutationStageKindSchema,
    recoveryAction: workItemRecoveryActionSchema,
  }).strict()
  const succeeded = z.object({
    ...base,
    state: z.literal('succeeded'),
    workItemId: boardWorkItemId,
    issueNumber: positiveInteger,
    url: safeUrl,
    remoteFingerprint: boardRemoteFingerprint,
  }).strict()
  const conflict = z.object({
    ...base,
    state: z.literal('conflict'),
    reason: z.enum(['expected-revision', 'stale-remote', 'mapping-repair-required']),
    workItemId: boardWorkItemId.optional(),
    remoteFingerprint: boardRemoteFingerprint.optional(),
  }).strict()
  const reconciliationRequired = z.object({
    ...base,
    state: z.literal('reconciliation-required'),
    reason: z.enum(['effect-unknown', 'evidence-conflict', 'marker-ambiguous']),
    workItemId: boardWorkItemId.optional(),
    stage: workItemMutationStageKindSchema,
  }).strict()
  const canceled = z.object({
    ...base,
    state: z.literal('canceled'),
    reason: z.literal('authority-revoked'),
    workItemId: boardWorkItemId.optional(),
  }).strict()
  const nonterminal = z.union([prepared, running, partialFailure])
  const sharedResults = createSharedIntentResultSchemas(
    succeeded,
    nonterminal,
    conflict,
    reconciliationRequired,
  )
  return z.union([
    ...sharedResults.prefix,
    sharedResults.reconciliationRequired,
    z.object({ ok: z.literal(false), reason: z.literal('canceled'), receipt: canceled }).strict(),
  ]).superRefine(validateIntentResultReceiptIdentity)
}

/** CreateWorkItem business-result schema with only browser-safe saga evidence. */
export const sakiCreateWorkItemResultSchema = createWorkItemResultSchema(
  'create-work-item',
) satisfies z.ZodType<SakiWorkItemIntentReceipt<'create-work-item'>>

/** MoveWorkItem business-result schema with only browser-safe saga evidence. */
export const sakiMoveWorkItemResultSchema = createWorkItemResultSchema(
  'move-work-item',
) satisfies z.ZodType<SakiWorkItemIntentReceipt<'move-work-item'>>

const giveWorkItemToAgentReceiptBase = {
  ...receiptIdentity,
  type: z.literal('give-work-item-to-agent'),
  projectId,
  workItemId: boardWorkItemId,
  assignmentId,
  workSessionId: sakiWorkSessionIdSchema,
  agentRunId: sakiAgentRunIdSchema,
  dispatchId: sakiExecutionDispatchIdSchema,
} as const

const giveWorkItemToAgentNonterminalReceiptSchema = z.object({
  ...giveWorkItemToAgentReceiptBase,
  state: z.enum(['prepared', 'admission-reserved', 'dispatching']),
}).strict()

const giveWorkItemToAgentConflictReceiptSchema = z.object({
  ...giveWorkItemToAgentReceiptBase,
  state: z.literal('conflict'),
  reason: z.enum([
    'expected-revision',
    'stale-remote',
    'work-item-not-ready',
    'work-item-blocked',
    'acceptance-criteria-missing',
    'binding-unavailable',
    'inherited-changes-unsafe',
    'writable-run-active',
    'branch-protected',
    'legacy-protection-unknown',
  ]),
}).strict()

/** Give-to-Agent business result with only browser-safe durable identities. */
export const sakiGiveWorkItemToAgentResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    receipt: z.object({
      ...giveWorkItemToAgentReceiptBase,
      state: z.literal('started'),
    }).strict(),
  }).strict(),
  z.object({ ok: z.literal(false), reason: z.literal('denied') }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.literal('unavailable'),
    detail: z.enum([
      'work-item-detail-unavailable',
      'branch-safety-unavailable',
      'agent-profile-unavailable',
      'model-route-unavailable',
      'host-unavailable',
    ]).optional(),
    receipt: giveWorkItemToAgentNonterminalReceiptSchema.optional(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.literal('conflict'),
    receipt: giveWorkItemToAgentConflictReceiptSchema.optional(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.literal('canceled'),
    receipt: z.object({
      ...giveWorkItemToAgentReceiptBase,
      state: z.literal('canceled'),
      reason: z.literal('authority-revoked'),
    }).strict(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.literal('reconciliation-required'),
    receipt: z.object({
      ...giveWorkItemToAgentReceiptBase,
      state: z.literal('reconciliation-required'),
      reason: z.enum(['effect-unknown', 'evidence-conflict', 'protocol']),
    }).strict(),
  }).strict(),
]).superRefine(validateIntentResultReceiptIdentity) satisfies z.ZodType<SakiGiveWorkItemToAgentIntentReceipt>

/** Union schema retained for callers that intentionally handle every Control Intent result. */
export const sakiIntentResultSchema = z.union([
  sakiRegisterDevelopmentProjectResultSchema,
  sakiConfigureGitHubSynchronizationResultSchema,
  sakiStageFilesResultSchema,
  sakiUnstageFilesResultSchema,
  sakiCreateCommitResultSchema,
  sakiCreateWorkItemResultSchema,
  sakiMoveWorkItemResultSchema,
  sakiGiveWorkItemToAgentResultSchema,
]) satisfies z.ZodType<SakiIntentReceipt>

/** Browser Access Projection inferred from the strict wire schema. */
export type SakiWireAccessProjection = z.infer<typeof sakiAccessProjectionSchema>
/** Browser bootstrap exchange result inferred from the strict wire schema. */
export type SakiWireAccessExchangeResult = z.infer<typeof sakiAccessExchangeResultSchema>
/** Browser logout result inferred from the strict wire schema. */
export type SakiWireAccessLogoutResult = z.infer<typeof sakiAccessLogoutResultSchema>
/** Browser Project-index query result inferred from its exact wire schema. */
export type SakiWireProjectIndexResult = z.infer<typeof sakiProjectIndexResultSchema>
/** Browser inspection query result inferred from its exact wire schema. */
export type SakiWireInspectProjectSelectionResult = z.infer<typeof sakiInspectProjectSelectionResultSchema>
/** Browser Development-Workspace result inferred from its exact wire schema. */
export type SakiWireDevelopmentWorkspaceResult = z.infer<typeof sakiDevelopmentWorkspaceResultSchema>
/** Browser Project-status result inferred from its exact wire schema. */
export type SakiWireProjectChangesResult = z.infer<typeof sakiProjectChangesResultSchema>
/** Browser Project-Diff result inferred from its exact wire schema. */
export type SakiWireProjectDiffResult = z.infer<typeof sakiProjectDiffResultSchema>
/** Opaque browser Diff request inferred from the shared execution schema. */
export type SakiWireProjectDiffRequest = z.infer<typeof readProjectDiffRequestSchema>
/** Browser Project Settings result inferred from its exact wire schema. */
export type SakiWireProjectSettingsResult = z.infer<typeof sakiProjectSettingsResultSchema>
/** Browser Board result inferred from its exact wire schema. */
export type SakiWireBoardResult = z.infer<typeof sakiBoardResultSchema>
/** Explicit browser Board refresh policy. */
export type SakiWireBoardRefresh = Extract<SakiQuery, { readonly type: 'board' }>['refresh']
/** Browser result union for code that handles every protected query kind. */
export type SakiWireQueryResult = z.infer<typeof sakiQueryResultSchema>
/** Browser Control Intent inferred from the strict wire schema. */
export type SakiWireIntent = z.infer<typeof sakiIntentRequestSchema>
/** Browser registration result inferred from the strict wire schema. */
export type SakiWireIntentResult = z.infer<typeof sakiIntentResultSchema>
/** Browser registration Intent inferred from its strict wire schema. */
export type SakiWireRegisterDevelopmentProjectIntent = z.infer<typeof sakiRegisterDevelopmentProjectIntentSchema>
/** Browser registration result inferred from its exact wire schema. */
export type SakiWireRegisterDevelopmentProjectResult = z.infer<typeof sakiRegisterDevelopmentProjectResultSchema>
/** Browser GitHub synchronization configuration Intent inferred from its strict wire schema. */
export type SakiWireConfigureGitHubSynchronizationIntent = z.infer<
  typeof sakiConfigureGitHubSynchronizationIntentSchema
>
/** Browser GitHub synchronization configuration result inferred from its exact wire schema. */
export type SakiWireConfigureGitHubSynchronizationResult = z.infer<
  typeof sakiConfigureGitHubSynchronizationResultSchema
>
/** Browser Git mutation expectation inferred from its strict authority-free schema. */
export type SakiWireGitMutationExpectation = z.infer<typeof sakiGitMutationExpectationSchema>
/** Browser StageFiles Intent inferred from its strict path-free schema. */
export type SakiWireStageFilesIntent = z.infer<typeof sakiStageFilesIntentSchema>
/** Browser StageFiles result inferred from its exact safe receipt schema. */
export type SakiWireStageFilesResult = z.infer<typeof sakiStageFilesResultSchema>
/** Browser UnstageFiles Intent inferred from its strict path-free schema. */
export type SakiWireUnstageFilesIntent = z.infer<typeof sakiUnstageFilesIntentSchema>
/** Browser UnstageFiles result inferred from its exact safe receipt schema. */
export type SakiWireUnstageFilesResult = z.infer<typeof sakiUnstageFilesResultSchema>
/** Browser CreateCommit Intent inferred from its strict identity-free schema. */
export type SakiWireCreateCommitIntent = z.infer<typeof sakiCreateCommitIntentSchema>
/** Browser CreateCommit result inferred from its exact safe receipt schema. */
export type SakiWireCreateCommitResult = z.infer<typeof sakiCreateCommitResultSchema>
/** Browser CreateWorkItem Intent inferred from its strict authority-free schema. */
export type SakiWireCreateWorkItemIntent = z.infer<typeof sakiCreateWorkItemIntentSchema>
/** Browser CreateWorkItem result inferred from its exact safe receipt schema. */
export type SakiWireCreateWorkItemResult = z.infer<typeof sakiCreateWorkItemResultSchema>
/** Browser MoveWorkItem Intent inferred from its strict Saki-relative schema. */
export type SakiWireMoveWorkItemIntent = z.infer<typeof sakiMoveWorkItemIntentSchema>
/** Browser MoveWorkItem result inferred from its exact safe receipt schema. */
export type SakiWireMoveWorkItemResult = z.infer<typeof sakiMoveWorkItemResultSchema>
/** Browser Give-to-Agent Intent inferred from its strict authority-free schema. */
export type SakiWireGiveWorkItemToAgentIntent = z.infer<typeof sakiGiveWorkItemToAgentIntentSchema>
/** Browser Give-to-Agent result inferred from its exact safe receipt schema. */
export type SakiWireGiveWorkItemToAgentResult = z.infer<typeof sakiGiveWorkItemToAgentResultSchema>
/** Branded Host id accepted by the browser client. */
export type SakiWireHostId = SakiHostId
/** Branded Project id accepted by the browser client. */
export type SakiWireProjectId = SakiDevelopmentProjectId
