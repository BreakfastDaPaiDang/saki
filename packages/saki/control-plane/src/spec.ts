/** Durable Saki provisioning, entity, and Installation Access schemas. @module @breakfastdapaidang/saki-control-plane/src/spec */

import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { CallId } from '@deepseek-ai/dsh-llm'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { workspaceIdSchema } from '@deepseek-ai/dsh-workspace'
import {
  githubAccountIdSchema,
  githubAppIdSchema,
  githubExternalOperationId,
  githubExternalOperationIdSchema,
  githubFailureSchema,
  githubInstallationIdSchema,
  githubIssueIdSchema,
  githubIssueStateSnapshotSchema,
  githubInstallationProfileSchema,
  githubProjectBoardFingerprintSchema,
  githubProjectFieldIdSchema,
  githubProjectIdSchema,
  githubProjectItemIdSchema,
  githubProjectItemAddSnapshotSchema,
  githubProjectItemPositionSnapshotSchema,
  githubProjectOptionIdSchema,
  githubRepositoryDatabaseIdSchema,
  githubRepositoryIdSchema,
  type GitHubExternalOperationId,
} from '@breakfastdapaidang/saki-github'
import {
  hostOperationPreparationSchema,
  hostOperationSnapshotSchema,
  commitHostOperationRequestSchema,
  canonicalDigest,
  inheritedChangeBaselineIdentityMaterial,
  inheritedChangeBaselineSchema,
  isAbsoluteHostPath,
  isGitObjectId,
  MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES,
  MAX_HOST_OPERATION_SELECTED_CHANGES,
  MAX_TRUSTED_PATH_CHARS,
  projectGitHeadSchema,
  projectGitStatusFingerprintSchema,
  projectGitWorktreeFingerprintSchema,
  projectInspectionWorkspaceIndependentMaterial,
  projectSelectionInspectionSchema,
  sakiAgentRunIdSchema,
  sakiExecutionDispatchIdSchema,
  sakiWorkSessionIdSchema,
  startAgentRunHostOperationRequestSchema,
  startAgentRunHostOperationRequestV2Schema,
  startAgentRunHostOperationResultSchema,
  stageFilesHostOperationRequestSchema,
  selectedProjectGitChangeSchema,
  unstageFilesHostOperationRequestSchema,
} from '@breakfastdapaidang/saki-execution'
import {
  MAX_AGENT_RUN_DISPATCHES,
  MAX_INTERVENTION_ANSWER_CHARS,
  MAX_INTERVENTION_PROMPT_CHARS,
  SAKI_BOARD_WORK_ITEM_LIMIT,
  SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
  SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
} from './constants.ts'
export {
  MAX_AGENT_RUN_DISPATCHES,
  MAX_INTERVENTION_ANSWER_CHARS,
  MAX_INTERVENTION_PROMPT_CHARS,
} from './constants.ts'
import {
  sakiBootstrapChallengeIdSchema as bootstrapChallengeId,
  sakiAgentProfileIdSchema as agentProfileId,
  sakiBoardRemoteFingerprintSchema as boardRemoteFingerprint,
  sakiBoardWorkItemIdSchema as boardWorkItemId,
  sakiBrowserSessionIdSchema as browserSessionId,
  sakiControlIntentIdSchema as controlIntentId,
  sakiDevelopmentProjectIdSchema as developmentProjectId,
  sakiGrantIdSchema as grantId,
  sakiDispatchClaimIdSchema as dispatchClaimId,
  sakiGitHubScanAttemptIdSchema as githubScanAttemptId,
  sakiHostIdSchema as hostId,
  sakiInstallationAccessIdSchema as installationAccessId,
  sakiInstallationGenerationIdSchema as installationGenerationId,
  sakiInstallationIdSchema as installationId,
  sakiIntentReceiptIdSchema as intentReceiptId,
  sakiInterventionRequestIdSchema as interventionRequestId,
  sakiWorkAssignmentIdSchema as workAssignmentId,
  sakiPrincipalIdSchema as principalId,
  sakiResourceBindingIdSchema as resourceBindingId,
  sakiStorageGenerationIdSchema as storageGenerationId,
  sakiWorkItemRecoveryIdSchema as workItemRecoveryId,
} from './ids.ts'
import {
  boardWorkItemId as deriveBoardWorkItemId,
  targetedBoardRemoteFingerprint,
} from './work-item-mapping.ts'
import {
  githubWorkItemIssueBodyWithinLimit,
  renderGitHubWorkItemIssueBody,
} from './work-item-issue.ts'
import type {
  SakiGrantId,
  SakiInterventionRequestId,
  SakiWorkAssignmentId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationId,
  SakiPrincipalId,
  SakiControlIntentId,
  SakiBoardWorkItemId,
  SakiDevelopmentProjectId,
  SakiResourceBindingId,
  SakiGitHubScanFailure,
  AnswerInterventionIntent,
  CreateCommitIntent,
  GiveWorkItemToAgentIntent,
  GitMutationExpectation,
  StageFilesIntent,
  SakiWorkItemRecoveryId,
  UnstageFilesIntent,
} from './types.ts'
import type {
  SakiAgentRunId,
  SakiExecutionDispatchId,
  SakiWorkSessionId,
} from '@breakfastdapaidang/saki-execution'

const revision = z.number().int().nonnegative()
const positiveRevision = z.number().int().positive()
const ordinal = z.number().int().nonnegative()
const timestamp = z.number().int().nonnegative()
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const projectTitle = z.string().min(1).max(200).refine(value => value.trim().length > 0)
const agentPresetId = z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9-]*$/u)
const trustedPath = z.string().min(1).max(MAX_TRUSTED_PATH_CHARS).refine(isAbsoluteHostPath)
const githubSafeText = z.string().min(1).max(4_096).regex(/^[^\u0000\u007f]*$/u)
const githubNameWithOwner = z.string()
  .regex(/^[^/\u0000-\u001f\u007f]+\/[^/\u0000-\u001f\u007f]+$/u)
  .max(201)
const githubSafeUrl = z.url().max(2_048).refine((value) => {
  const parsed = new URL(value)
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hash === ''
}, 'URL must be credential-free HTTPS without a fragment')

function boundedArrayPreflight(maximum: number, maximumMessage: string) {
  return z.unknown().superRefine((value, context) => {
    if (!Array.isArray(value)) {
      context.addIssue({ code: 'custom', message: 'value must be an array', continue: false })
    } else if (value.length > maximum) {
      context.addIssue({ code: 'custom', message: maximumMessage, continue: false })
    }
  })
}

/** Stable key of the one provisioning owner record. */
export const CONTROL_STATE_KEY = 'control-state' as const
/** Stable key of the singleton Development Project Registry aggregate. */
export const DEVELOPMENT_PROJECT_REGISTRY_KEY = 'development-project-registry' as const

/** Historical v2 provisioning owner with Foundation-owned generation identity. */
export const historicalControlStateRecordSchema = z.object({
  schemaVersion: z.literal(1),
  revision,
  phase: z.enum(['provisioning', 'ready']),
  installationId,
  initialInstallationGenerationId: installationGenerationId,
  initialHostId: hostId,
  hostOperatorPrincipalId: principalId,
  hostOperatorGrantId: grantId,
  installationAccessId,
}).strict()

/** Provisioning owner that records child identities before any child write. */
export const controlStateRecordSchema = historicalControlStateRecordSchema.omit({
  initialInstallationGenerationId: true,
}).extend({ schemaVersion: z.literal(2) })

/** Parsed durable control-state record. */
export type ControlStateRecord = z.infer<typeof controlStateRecordSchema>

/** Historical v2 Installation entity with the current generation reference. */
export const historicalInstallationRecordSchema = z.object({
  id: installationId,
  revision,
  state: z.enum(['active', 'retired']),
  currentInstallationGenerationId: installationGenerationId,
  currentHostId: hostId,
}).strict()

/** Independently revisioned Saki Installation entity. */
export const installationRecordSchema = historicalInstallationRecordSchema.omit({
  currentInstallationGenerationId: true,
})

/** Parsed durable Installation entity. */
export type InstallationRecord = z.infer<typeof installationRecordSchema>

/** Independently revisioned enrolled Host entity. */
export const hostRecordSchema = z.object({
  id: hostId,
  revision,
  installationId,
  state: z.enum(['enrolled', 'retired']),
}).strict()

/** Parsed durable Host entity. */
export type HostRecord = z.infer<typeof hostRecordSchema>

/** Independently revisioned human or automation Principal entity. */
export const principalRecordSchema = z.object({
  id: principalId,
  revision,
  kind: z.enum(['human', 'automation']),
  displayName: z.string().min(1),
  state: z.enum(['active', 'retired']),
}).strict()

/** Parsed durable Principal entity. */
export type PrincipalRecord = z.infer<typeof principalRecordSchema>

/** Exact action vocabulary retained by historical v2 and v3 Grant records. */
export const HISTORICAL_HOST_OPERATOR_ACTIONS = [
  'inspect-project-selection',
  'project-index:read',
  'development-workspace:read',
  'development-project:register',
] as const

/** Exact Host Operator action vocabulary retained by v4 Grant records. */
export const V4_HOST_OPERATOR_ACTIONS = [
  ...HISTORICAL_HOST_OPERATOR_ACTIONS,
  'board:read',
  'project-settings:read',
  'github-synchronization:configure',
] as const

/** Exact Host Operator action vocabulary retained by v5 Grant records. */
export const V5_HOST_OPERATOR_ACTIONS = [
  ...V4_HOST_OPERATOR_ACTIONS,
  'project-changes:read',
  'project-diff:read',
  'project-changes:stage',
  'project-changes:unstage',
  'project-commit:create',
] as const

/** Exact Host Operator action vocabulary retained by v6 Grant records. */
export const V6_HOST_OPERATOR_ACTIONS = [
  ...V5_HOST_OPERATOR_ACTIONS,
  'work-item:create',
  'work-item:move',
] as const

/** Exact Host Operator actions retained for v7 product state. */
export const V7_HOST_OPERATOR_ACTIONS = [
  ...V6_HOST_OPERATOR_ACTIONS,
  'work-item:give-to-agent',
] as const

/** Current Host Operator actions, including Principal-scoped work and Intervention answers. */
export const HOST_OPERATOR_ACTIONS = [
  ...V7_HOST_OPERATOR_ACTIONS,
  'my-work:read',
  'attention:read',
  'intervention:answer',
] as const

const grantRecordSharedShape = {
  id: grantId,
  revision,
  installationId,
  principalId,
  state: z.enum(['active', 'revoked']),
  scope: z.object({
    kind: z.literal('installation'),
    installationId,
  }).strict(),
} as const

/** Exact Grant schema retained for v2 and v3 product state. */
export const historicalGrantRecordSchema = z.object({
  ...grantRecordSharedShape,
  actions: z.array(z.enum(HISTORICAL_HOST_OPERATOR_ACTIONS)),
}).strict()

/** Exact Grant schema retained for v4 product state. */
export const v4GrantRecordSchema = z.object({
  ...grantRecordSharedShape,
  actions: z.array(z.enum(V4_HOST_OPERATOR_ACTIONS)),
}).strict()

/** Exact independently revisioned v5 Host Operator Grant entity. */
export const v5GrantRecordSchema = z.object({
  ...grantRecordSharedShape,
  actions: z.array(z.enum(V5_HOST_OPERATOR_ACTIONS)),
}).strict()

/** Exact independently revisioned v6 Host Operator Grant entity. */
export const v6GrantRecordSchema = z.object({
  ...grantRecordSharedShape,
  actions: z.array(z.enum(V6_HOST_OPERATOR_ACTIONS)),
}).strict()

/** Exact independently revisioned v7 Host Operator Grant entity. */
export const v7GrantRecordSchema = z.object({
  ...grantRecordSharedShape,
  actions: z.array(z.enum(V7_HOST_OPERATOR_ACTIONS)),
}).strict()

/** Independently revisioned current Host Operator Grant entity. */
export const grantRecordSchema = z.object({
  ...grantRecordSharedShape,
  actions: z.array(z.enum(HOST_OPERATOR_ACTIONS)),
}).strict()

/** Parsed durable Grant entity. */
export type GrantRecord = z.infer<typeof grantRecordSchema>

/** Historical v2 Bootstrap Challenge tied to an Installation State Generation. */
export const historicalBootstrapChallengeRecordSchema = z.object({
  id: bootstrapChallengeId,
  ordinal,
  revision,
  purpose: z.enum(['initial-bootstrap', 'local-reauthentication']),
  installationId,
  installationGenerationId,
  hostId,
  principalId,
  verifierDigest: digest,
  issuedAt: timestamp,
  expiresAt: timestamp,
  state: z.enum(['issued', 'consumed', 'expired', 'revoked']),
  terminalAt: timestamp.optional(),
  browserSessionId: browserSessionId.optional(),
}).strict()

/** One digest-only Bootstrap Challenge entry. */
export const bootstrapChallengeRecordSchema = historicalBootstrapChallengeRecordSchema
  .omit({ installationGenerationId: true })
  .extend({ storageGenerationId })

/** Parsed durable Bootstrap Challenge entry. */
export type BootstrapChallengeRecord = z.infer<typeof bootstrapChallengeRecordSchema>

/** Historical v2 Browser Session tied to an Installation State Generation. */
export const historicalBrowserSessionRecordSchema = z.object({
  id: browserSessionId,
  ordinal,
  revision,
  installationId,
  installationGenerationId,
  principalId,
  cookieDigest: digest,
  createdAt: timestamp,
  expiresAt: timestamp,
  state: z.enum(['active', 'expired', 'revoked']),
  terminalAt: timestamp.optional(),
}).strict()

/** One digest-only Browser Session entry. */
export const browserSessionRecordSchema = historicalBrowserSessionRecordSchema
  .omit({ installationGenerationId: true })
  .extend({ storageGenerationId })

/** Parsed durable Browser Session entry. */
export type BrowserSessionRecord = z.infer<typeof browserSessionRecordSchema>

/** Immutable audit summary retained after detailed terminal records are cleaned. */
export const bootstrapCompletionRecordSchema = z.object({
  challengeId: bootstrapChallengeId,
  sessionId: browserSessionId,
  hostId,
  principalId,
  completedAt: timestamp,
}).strict()

/** Parsed durable initial-bootstrap completion summary. */
export type BootstrapCompletionRecord = z.infer<typeof bootstrapCompletionRecordSchema>

/** Historical v2 Installation Access aggregate. */
export const historicalInstallationAccessRecordSchema = z.object({
  id: installationAccessId,
  schemaVersion: z.literal(1),
  revision,
  installationId,
  nextChallengeOrdinal: ordinal,
  nextSessionOrdinal: ordinal,
  bootstrapCompletion: bootstrapCompletionRecordSchema.optional(),
  requestTokenDerivation: z.object({
    version: z.literal(1),
    domain: z.literal('saki/browser-request-token'),
  }).strict(),
  challenges: z.array(historicalBootstrapChallengeRecordSchema),
  sessions: z.array(historicalBrowserSessionRecordSchema),
}).strict()

/** Single versioned Installation Access aggregate owner record. */
export const installationAccessRecordSchema = historicalInstallationAccessRecordSchema.extend({
  schemaVersion: z.literal(2),
  challenges: z.array(bootstrapChallengeRecordSchema),
  sessions: z.array(browserSessionRecordSchema),
})

/** Parsed durable Installation Access aggregate. */
export type InstallationAccessRecord = z.infer<typeof installationAccessRecordSchema>

/** Exact historical v6 Development Project child record. */
export const developmentProjectV1RecordSchema = z.object({
  id: developmentProjectId,
  revision,
  projectTitle,
  resourceBindingId,
  state: z.literal('active'),
  createdAt: timestamp,
}).strict()

/** Parsed exact historical v6 Development Project child. */
export type DevelopmentProjectV1Record = z.infer<typeof developmentProjectV1RecordSchema>

/** Explicit provider and model selection retained by one Agent Profile. */
export const agentModelRouteRequestSchema = z.object({
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
}).strict()

/** One current immutable Agent Profile version owned by a Development Project. */
export const agentProfileRecordSchema = z.object({
  id: agentProfileId,
  projectId: developmentProjectId,
  version: z.number().int().positive(),
  agentPresetId,
  modelRouteRequest: agentModelRouteRequestSchema.nullable(),
  createdAt: timestamp,
}).strict()

/** Parsed current Agent Profile record. */
export type AgentProfileRecord = z.infer<typeof agentProfileRecordSchema>

/** One titled Development Project child with an explicit default Agent Profile. */
export const developmentProjectRecordSchema = developmentProjectV1RecordSchema.extend({
  defaultAgentProfileId: agentProfileId,
})

/** Parsed durable Development Project child. */
export type DevelopmentProjectRecord = z.infer<typeof developmentProjectRecordSchema>

/** One Host-owned Resource Binding child with registration and current observations. */
export const resourceBindingRecordSchema = z.object({
  id: resourceBindingId,
  revision,
  projectId: developmentProjectId,
  hostId,
  workspaceId: workspaceIdSchema,
  health: z.enum(['active', 'missing', 'repair-required']),
  registrationInspection: projectSelectionInspectionSchema,
  currentInspection: projectSelectionInspectionSchema.optional(),
  inheritedChangeBaseline: inheritedChangeBaselineSchema,
  createdAt: timestamp,
  observedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (value.observedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'binding observation predates creation', path: ['observedAt'] })
  }
  if (value.registrationInspection.projection.hostId !== value.hostId
    || (value.currentInspection !== undefined && value.currentInspection.projection.hostId !== value.hostId)) {
    context.addIssue({ code: 'custom', message: 'binding inspection belongs to another Host' })
  }
  if (canonicalDigest('saki/inherited-baseline/identity/v1',
    inheritedChangeBaselineIdentityMaterial(value.registrationInspection.projection.baseline))
    !== canonicalDigest('saki/inherited-baseline/identity/v1',
      inheritedChangeBaselineIdentityMaterial(value.inheritedChangeBaseline))) {
    context.addIssue({ code: 'custom', message: 'binding inherited baseline differs from registration evidence' })
  }
  if (value.health === 'active' && value.currentInspection === undefined) {
    context.addIssue({ code: 'custom', message: 'active binding has no current inspection' })
  }
  if (value.health === 'missing' && value.currentInspection !== undefined) {
    context.addIssue({ code: 'custom', message: 'missing binding retains a current inspection' })
  }
  if (value.currentInspection !== undefined) {
    if (value.currentInspection.projection.workspaceId === undefined
      || value.currentInspection.projection.workspaceId !== value.workspaceId) {
      context.addIssue({ code: 'custom', message: 'binding current inspection disagrees with Workspace identity' })
    }
    if (value.currentInspection.trusted.canonicalWorktreePath
        !== value.registrationInspection.trusted.canonicalWorktreePath
      || value.currentInspection.trusted.canonicalGitDirectory
        !== value.registrationInspection.trusted.canonicalGitDirectory
      || value.currentInspection.trusted.canonicalCommonGitDirectory
        !== value.registrationInspection.trusted.canonicalCommonGitDirectory
      || value.currentInspection.trusted.gitDirectoryIdentity.digest
        !== value.registrationInspection.trusted.gitDirectoryIdentity.digest
      || value.currentInspection.trusted.commonGitDirectoryIdentity.digest
        !== value.registrationInspection.trusted.commonGitDirectoryIdentity.digest) {
      context.addIssue({ code: 'custom', message: 'binding current inspection changed resource identity' })
    }
  }
})

/** Parsed durable Resource Binding child. */
export type ResourceBindingRecord = z.infer<typeof resourceBindingRecordSchema>

/** One canonical-path duplicate index entry owned by the registry aggregate. */
const bindingPathIndexSchema = z.object({
  hostId,
  path: trustedPath,
  resourceBindingId,
}).strict()

/** One accepted Intent-to-created-children mapping. */
const registryIntentMappingSchema = z.object({
  intentId: controlIntentId,
  projectId: developmentProjectId,
  resourceBindingId,
  registryRevision: revision,
}).strict()

/** Exact historical v6 singleton Development Project Registry aggregate. */
export const developmentProjectRegistryV1RecordSchema = z.object({
  id: z.literal(DEVELOPMENT_PROJECT_REGISTRY_KEY),
  schemaVersion: z.literal(1),
  revision,
  projects: z.array(developmentProjectV1RecordSchema),
  resourceBindings: z.array(resourceBindingRecordSchema),
  canonicalWorktreeIndex: z.array(bindingPathIndexSchema),
  gitDirectoryIndex: z.array(bindingPathIndexSchema),
  intentMappings: z.array(registryIntentMappingSchema),
}).strict()

/** Parsed exact historical v6 Development Project Registry aggregate. */
export type DevelopmentProjectRegistryV1Record = z.infer<typeof developmentProjectRegistryV1RecordSchema>

/** Singleton Development Project Registry aggregate. */
export const developmentProjectRegistryRecordSchema = developmentProjectRegistryV1RecordSchema.extend({
  schemaVersion: z.literal(2),
  projects: z.array(developmentProjectRecordSchema),
  agentProfiles: z.array(agentProfileRecordSchema),
})

/** Parsed singleton Development Project Registry aggregate. */
export type DevelopmentProjectRegistryRecord = z.infer<typeof developmentProjectRegistryRecordSchema>

/** Strict durable first Control Intent payload. */
export const registerDevelopmentProjectIntentSchema = z.object({
  type: z.literal('register-development-project'),
  intentId: controlIntentId,
  projectTitle,
  hostId,
  directoryLocator: z.string().min(1).max(32_768),
  expectedRegistryRevision: revision,
  confirmedFingerprint: z.object({ version: z.literal(2), digest }).strict(),
  confirmedBaseline: inheritedChangeBaselineSchema,
}).strict()

/** Strict browser-confirmed evidence shared by structured Git mutation Intents. */
export const gitMutationExpectationSchema: z.ZodType<GitMutationExpectation> = z.object({
  projectId: developmentProjectId,
  expectedRegistryRevision: revision,
  expectedProjectRevision: revision,
  expectedBinding: z.object({ id: resourceBindingId, revision }).strict(),
  expectedStatus: projectGitStatusFingerprintSchema,
  expectedHead: projectGitHeadSchema,
  expectedIndex: z.object({
    kind: z.literal('tree'),
    treeId: z.string().refine(value => isGitObjectId(value)),
  }).strict(),
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
})

const selectedGitChangesSchema = boundedArrayPreflight(
  MAX_HOST_OPERATION_SELECTED_CHANGES,
  'structured Git selection exceeds the protocol row limit',
).pipe(z.array(selectedProjectGitChangeSchema)
  .min(1)
  .max(MAX_HOST_OPERATION_SELECTED_CHANGES))
  .superRefine((changes, context) => {
    if (new Set(changes.map(change => change.id)).size !== changes.length) {
      context.addIssue({ code: 'custom', message: 'structured Git selection repeats a change id' })
    }
  })

/** Strict StageFiles Control Intent; browser paths are never accepted. */
export const stageFilesIntentSchema = z.object({
  type: z.literal('stage-files'),
  intentId: controlIntentId,
  expected: gitMutationExpectationSchema,
  changes: selectedGitChangesSchema,
}).strict() satisfies z.ZodType<StageFilesIntent>

/** Strict UnstageFiles Control Intent; browser paths are never accepted. */
export const unstageFilesIntentSchema = z.object({
  type: z.literal('unstage-files'),
  intentId: controlIntentId,
  expected: gitMutationExpectationSchema,
  changes: selectedGitChangesSchema,
}).strict() satisfies z.ZodType<UnstageFilesIntent>

const commitMessageSchema = z.string()
  .min(1)
  .max(MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES)
  .pipe(z.string()
    .refine(value => !value.includes('\0'))
    .refine(value => value.isWellFormed())
    .refine(value => new TextEncoder().encode(value).byteLength <= MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES))

/** Strict deterministic CreateCommit Control Intent without identity or ref inputs. */
export const createCommitIntentSchema = z.object({
  type: z.literal('create-commit'),
  intentId: controlIntentId,
  expected: gitMutationExpectationSchema,
  message: commitMessageSchema,
}).strict() satisfies z.ZodType<CreateCommitIntent>

/** Historical v2 registration authority evidence tied to an Installation State Generation. */
export const historicalRegistrationActorSchema = z.object({
  installationId,
  installationGenerationId,
  hostId,
  principalId,
  principalRevision: revision,
  grantId,
  grantRevision: revision,
}).strict()

/** Server-derived authority evidence retained in the immutable Intent digest. */
export const controlIntentActorSchema = historicalRegistrationActorSchema
  .omit({ installationGenerationId: true })
  .extend({ storageGenerationId })

/** Backward-compatible schema name for Project-registration records. */
export const registrationActorSchema = controlIntentActorSchema

/** Parsed server-derived registration authority evidence. */
export type ControlIntentActor = z.infer<typeof controlIntentActorSchema>
/** Authority attribution retained by Project-registration Intents. */
export type RegistrationActor = ControlIntentActor

const registrationIntentRecordSharedShape = {
  id: controlIntentId,
  revision,
  receiptId: intentReceiptId,
  payloadDigest: digest,
  inspection: projectSelectionInspectionSchema,
  workspaceInspection: projectSelectionInspectionSchema.optional(),
  phase: z.enum([
    'prepared',
    'workspace-dispatching',
    'workspace-observed',
    'registry-committed',
    'confirmed',
    'conflict',
    'failure',
    'reconciliation-required',
  ]),
  workspaceId: workspaceIdSchema.optional(),
  projectId: developmentProjectId.optional(),
  resourceBindingId: resourceBindingId.optional(),
  registryRevision: revision.optional(),
  terminalReason: z.enum([
    'expected-revision', 'duplicate-binding', 'authority', 'workspace', 'observation',
  ]).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
} as const

const historicalRegistrationIntentRecordBaseSchema = z.object({
  ...registrationIntentRecordSharedShape,
  schemaVersion: z.literal(1),
  payload: z.object({
    intent: registerDevelopmentProjectIntentSchema,
    actor: historicalRegistrationActorSchema,
  }).strict(),
}).strict()

const registrationIntentRecordBaseSchema = z.object({
  ...registrationIntentRecordSharedShape,
  schemaVersion: z.literal(2),
  payload: z.object({
    intent: registerDevelopmentProjectIntentSchema,
    actor: registrationActorSchema,
  }).strict(),
}).strict()

type RegistrationIntentRecordForValidation =
  | z.infer<typeof historicalRegistrationIntentRecordBaseSchema>
  | z.infer<typeof registrationIntentRecordBaseSchema>

interface DurableIntentIdentityForValidation {
  readonly id: string
  readonly receiptId: string
  readonly payload: { readonly intent: { readonly intentId: string } }
}

function refineDurableIntentIdentity(
  value: DurableIntentIdentityForValidation,
  context: z.RefinementCtx,
): void {
  if (value.id !== value.payload.intent.intentId) {
    context.addIssue({ code: 'custom', message: 'Intent id disagrees with immutable payload', path: ['id'] })
  }
  if (value.receiptId !== value.id.replace(/^intent-/u, 'receipt-')) {
    context.addIssue({ code: 'custom', message: 'receipt id disagrees with Intent id', path: ['receiptId'] })
  }
}

function refineRegistrationIntent(
  value: RegistrationIntentRecordForValidation,
  context: z.RefinementCtx,
): void {
  refineDurableIntentIdentity(value, context)
  const terminal = value.phase === 'conflict'
    || value.phase === 'failure'
    || value.phase === 'reconciliation-required'
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'Intent update predates creation', path: ['updatedAt'] })
  }
  if (terminal !== (value.terminalReason !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Intent terminal reason disagrees with phase', path: ['terminalReason'] })
  }
  if (value.payload.actor.hostId !== value.payload.intent.hostId) {
    context.addIssue({ code: 'custom', message: 'registration actor belongs to another Host' })
  }
  if (value.payload.intent.hostId !== value.inspection.projection.hostId
    || value.payload.intent.confirmedFingerprint.digest !== value.inspection.projection.fingerprint.digest
    || canonicalDigest('saki/inherited-baseline/identity/v1',
      inheritedChangeBaselineIdentityMaterial(value.payload.intent.confirmedBaseline))
      !== canonicalDigest('saki/inherited-baseline/identity/v1',
        inheritedChangeBaselineIdentityMaterial(value.inspection.projection.baseline))) {
    context.addIssue({ code: 'custom', message: 'Intent confirmation disagrees with retained inspection' })
  }
  if (canonicalDigest('saki/register-development-project/v1', value.payload) !== value.payloadDigest) {
    context.addIssue({ code: 'custom', message: 'Intent payload digest is stale', path: ['payloadDigest'] })
  }
  const hasWorkspace = value.workspaceId !== undefined
  if (value.workspaceInspection !== undefined && value.workspaceId === undefined) {
    context.addIssue({ code: 'custom', message: 'Workspace inspection has no retained identity' })
  }
  if (value.workspaceInspection !== undefined && value.workspaceId !== undefined) {
    if (value.workspaceInspection.projection.hostId !== value.payload.intent.hostId) {
      context.addIssue({ code: 'custom', message: 'Workspace observation disagrees with retained identity' })
    }
    const requiresCasEvidence = value.phase === 'workspace-observed'
      || value.phase === 'registry-committed'
      || value.phase === 'confirmed'
      || value.phase === 'conflict'
    if (requiresCasEvidence) {
      if (value.workspaceInspection.projection.workspaceId === undefined
        || value.workspaceInspection.projection.workspaceId !== value.workspaceId) {
        context.addIssue({ code: 'custom', message: 'Workspace observation disagrees with retained identity' })
      }
      const originalWorkspaceId = value.inspection.projection.workspaceId
      if (originalWorkspaceId !== undefined && originalWorkspaceId !== value.workspaceId) {
        context.addIssue({ code: 'custom', message: 'Existing Workspace identity changed during registration' })
      }
      if (canonicalDigest('saki/project-inspection/workspace-independent/v1',
        projectInspectionWorkspaceIndependentMaterial(
          value.workspaceInspection.projection,
          value.workspaceInspection.trusted,
        ))
        !== canonicalDigest('saki/project-inspection/workspace-independent/v1',
          projectInspectionWorkspaceIndependentMaterial(value.inspection.projection, value.inspection.trusted))) {
        context.addIssue({ code: 'custom', message: 'Workspace observation changed repository evidence' })
      }
    }
  }
  const committedFields = [
    value.projectId,
    value.resourceBindingId,
    value.registryRevision,
  ]
  const committedCount = committedFields.filter(field => field !== undefined).length
  if (committedCount !== 0 && committedCount !== committedFields.length) {
    context.addIssue({ code: 'custom', message: 'registry commit fields must appear together' })
  }
  if ((value.phase === 'prepared' || value.phase === 'workspace-dispatching') && (hasWorkspace || committedCount !== 0)) {
    context.addIssue({ code: 'custom', message: 'early Intent phase contains later-phase evidence' })
  }
  if (value.phase === 'workspace-observed' && (!hasWorkspace || committedCount !== 0)) {
    context.addIssue({ code: 'custom', message: 'workspace-observed phase evidence is incomplete' })
  }
  if ((value.phase === 'registry-committed' || value.phase === 'confirmed')
    && (!hasWorkspace || value.workspaceInspection === undefined
      || committedCount !== committedFields.length)) {
    context.addIssue({ code: 'custom', message: 'committed Intent phase evidence is incomplete' })
  }
  if (terminal && committedCount !== 0) {
    context.addIssue({ code: 'custom', message: 'terminal Intent contains registry commit evidence' })
  }
  if (value.registryRevision !== undefined
    && value.registryRevision !== value.payload.intent.expectedRegistryRevision + 1) {
    context.addIssue({ code: 'custom', message: 'Intent commit revision disagrees with expected revision' })
  }
  if (value.phase === 'conflict'
    && value.terminalReason !== 'expected-revision'
    && value.terminalReason !== 'duplicate-binding') {
    context.addIssue({ code: 'custom', message: 'conflict phase has an invalid terminal reason' })
  }
  if (value.phase === 'conflict' && (!hasWorkspace || value.workspaceInspection === undefined)) {
    context.addIssue({ code: 'custom', message: 'conflict phase has no Workspace evidence' })
  }
  if (value.phase === 'failure' && value.terminalReason !== 'authority') {
    context.addIssue({ code: 'custom', message: 'failure phase has an invalid terminal reason' })
  }
  if (value.phase === 'failure' && hasWorkspace) {
    context.addIssue({ code: 'custom', message: 'authority failure contains Workspace evidence' })
  }
  if (value.phase === 'reconciliation-required'
    && value.terminalReason !== 'workspace'
    && value.terminalReason !== 'observation') {
    context.addIssue({ code: 'custom', message: 'reconciliation phase has an invalid terminal reason' })
  }
}

/** Historical v2 recoverable registration Intent. */
export const historicalRegistrationIntentRecordSchema = historicalRegistrationIntentRecordBaseSchema
  .superRefine(refineRegistrationIntent)

/** Persisted recoverable registration Intent. */
export const registrationIntentRecordSchema = registrationIntentRecordBaseSchema.superRefine(refineRegistrationIntent)

/** Parsed durable registration Intent. */
export type RegistrationIntentRecord = z.infer<typeof registrationIntentRecordSchema>

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

const nonTerminalBoardStatusSchema = z.enum([
  'inbox',
  'backlog',
  'ready',
  'in-progress',
  'in-review',
])

const workItemExpectedRevisionsSchema = z.object({
  projectRevision: revision,
  synchronizationRevision: positiveRevision,
  mappingRevision: positiveRevision,
}).strict()

const workItemPositionSchema = z.union([
  z.object({ afterWorkItemId: z.null() }).strict(),
  z.object({
    afterWorkItemId: boardWorkItemId,
    expectedAfterRemoteFingerprint: boardRemoteFingerprint,
  }).strict(),
])

/** Strict browser-facing Work Item creation Intent without provider authority ids. */
export const createWorkItemIntentSchema = z.object({
  type: z.literal('create-work-item'),
  intentId: controlIntentId,
  projectId: developmentProjectId,
  expected: workItemExpectedRevisionsSchema,
  title: projectTitle,
  intendedOutcome: githubSafeText,
  acceptanceCriteria: z.array(githubSafeText).min(1).max(50),
}).strict().superRefine((value, context) => {
  if (!githubWorkItemIssueBodyWithinLimit(value)) {
    context.addIssue({
      code: 'custom',
      message: 'generated GitHub Issue body exceeds the UTF-8 byte limit',
      path: ['acceptanceCriteria'],
    })
  }
})

/** Strict browser-facing Work Item move Intent without provider authority ids. */
export const moveWorkItemIntentSchema = z.object({
  type: z.literal('move-work-item'),
  intentId: controlIntentId,
  projectId: developmentProjectId,
  workItemId: boardWorkItemId,
  expectedRemoteFingerprint: boardRemoteFingerprint,
  targetStatus: boardStatusSchema,
  position: workItemPositionSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.position?.afterWorkItemId === value.workItemId) {
    context.addIssue({ code: 'custom', message: 'Work Item cannot be positioned after itself' })
  }
})

/** Strict manual Agent assignment Intent without execution or Host authority. */
export const giveWorkItemToAgentIntentSchema = z.object({
  type: z.literal('give-work-item-to-agent'),
  intentId: controlIntentId,
  projectId: developmentProjectId,
  workItemId: boardWorkItemId,
  expectedProjectRevision: revision,
  expectedRemoteFingerprint: boardRemoteFingerprint,
}).strict() satisfies z.ZodType<GiveWorkItemToAgentIntent>

const interventionAnswerTextSchema = z.string()
  .min(1)
  .max(MAX_INTERVENTION_ANSWER_CHARS)
  .refine(value => value.isWellFormed() && !value.includes('\0'))

/** Strict Host-Operator answer Intent without Actor, Grant, or delivery authority. */
export const answerInterventionIntentSchema = z.object({
  type: z.literal('answer-intervention'),
  intentId: controlIntentId,
  interventionId: interventionRequestId,
  expectedInterventionRevision: revision,
  answer: z.object({
    kind: z.literal('text'),
    text: interventionAnswerTextSchema,
  }).strict(),
}).strict() satisfies z.ZodType<AnswerInterventionIntent>

const githubWorkItemIntentSchema = z.discriminatedUnion('type', [
  createWorkItemIntentSchema,
  moveWorkItemIntentSchema,
])

/** Server-generated high-entropy identity used only to derive the hidden Issue-body marker. */
export type SakiWorkItemMarkerId = Branded<'SakiWorkItemMarkerId'>

const createMarkerIdSchema = z.string()
  .regex(/^work-item-marker-[0-9a-f]{64}$/u)
  .transform(value => value as SakiWorkItemMarkerId)

const createWorkItemTargetSchema = z.object({
  kind: z.literal('create-work-item'),
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  projectId: githubProjectIdSchema,
  statusFieldId: githubProjectFieldIdSchema,
  desiredStatusOptionId: githubProjectOptionIdSchema,
  markerId: createMarkerIdSchema,
}).strict()

const moveWorkItemTargetSchema = z.object({
  kind: z.literal('move-work-item'),
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  projectId: githubProjectIdSchema,
  issueId: githubIssueIdSchema,
  projectItemId: githubProjectItemIdSchema.optional(),
  source: z.discriminatedUnion('membership', [
    z.object({
      membership: z.literal('absent'),
      issueState: z.literal('open'),
      status: z.literal('inbox'),
    }).strict(),
    z.object({
      membership: z.literal('present'),
      issueState: z.enum(['open', 'closed']),
      status: boardStatusSchema,
      projectItemId: githubProjectItemIdSchema,
      archived: z.boolean(),
    }).strict(),
  ]),
  statusFieldId: githubProjectFieldIdSchema,
  desiredStatusOptionId: githubProjectOptionIdSchema,
  position: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('top') }).strict(),
    z.object({
      kind: z.literal('after'),
      workItemId: boardWorkItemId,
      projectItemId: githubProjectItemIdSchema,
      expectedRemoteFingerprint: boardRemoteFingerprint,
    }).strict(),
  ]).optional(),
}).strict()

const githubWorkItemTargetSchema = z.discriminatedUnion('kind', [
  createWorkItemTargetSchema,
  moveWorkItemTargetSchema,
])

const workItemMutationStageKindSchema = z.enum([
  'issue-create',
  'project-item-add',
  'project-item-status-set',
  'project-item-position-set',
  'issue-state-set',
])
type WorkItemMutationStageKind = z.infer<typeof workItemMutationStageKindSchema>

const workItemResolvedTargetBaseSchema = z.object({
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
}).strict()

const workItemResolvedStageTargetSchema = z.discriminatedUnion('kind', [
  workItemResolvedTargetBaseSchema.extend({
    kind: z.literal('issue-create'),
    markerId: createMarkerIdSchema,
    titleDigest: digest,
    bodyDigest: digest,
  }).strict(),
  workItemResolvedTargetBaseSchema.extend({
    kind: z.literal('project-item-add'),
    projectId: githubProjectIdSchema,
    issueId: githubIssueIdSchema,
  }).strict(),
  workItemResolvedTargetBaseSchema.extend({
    kind: z.literal('project-item-status-set'),
    projectId: githubProjectIdSchema,
    issueId: githubIssueIdSchema,
    projectItemId: githubProjectItemIdSchema,
    statusFieldId: githubProjectFieldIdSchema,
    desiredStatusOptionId: githubProjectOptionIdSchema,
  }).strict(),
  workItemResolvedTargetBaseSchema.extend({
    kind: z.literal('project-item-position-set'),
    projectId: githubProjectIdSchema,
    issueId: githubIssueIdSchema,
    projectItemId: githubProjectItemIdSchema,
    statusFieldId: githubProjectFieldIdSchema,
    afterItemId: githubProjectItemIdSchema.nullable(),
  }).strict(),
  workItemResolvedTargetBaseSchema.extend({
    kind: z.literal('issue-state-set'),
    issueId: githubIssueIdSchema,
    desiredState: z.enum(['open', 'closed']),
  }).strict(),
])

/**
 * Derive one stable external operation id for a durable Work Item stage.
 * @param intentId - owning Control Intent identity.
 * @param kind - atomic mutation stage kind.
 * @returns stage identity stable across retries and restart.
 */
export function githubWorkItemStageMutationId(
  intentId: SakiControlIntentId,
  kind: WorkItemMutationStageKind,
): GitHubExternalOperationId {
  const suffix = kind === 'issue-create'
    ? 'issue'
    : kind === 'project-item-add'
      ? 'membership'
      : kind === 'project-item-status-set'
        ? 'status'
        : kind === 'project-item-position-set'
          ? 'position'
          : 'issue-state'
  return githubExternalOperationId(`work-item:${intentId}:${suffix}`)
}

/**
 * Derive the durable recovery identity for one Work Item inside one Development Project.
 * @param projectId - owning Development Project identity.
 * @param workItemId - stable GitHub-backed Work Item identity.
 * @returns project-scoped recovery identity.
 */
export function githubWorkItemRecoveryId(
  projectId: SakiDevelopmentProjectId,
  workItemId: SakiBoardWorkItemId,
): SakiWorkItemRecoveryId {
  return `work-item-recovery-${canonicalDigest('saki/work-item-recovery/v1', {
    projectId,
    workItemId,
  })}` as SakiWorkItemRecoveryId
}

const workItemMutationStageSchema = z.object({
  mutationId: githubExternalOperationIdSchema,
  kind: workItemMutationStageKindSchema,
  resolvedTarget: workItemResolvedStageTargetSchema.optional(),
  state: z.enum(['prepared', 'dispatching', 'confirmed', 'failed']),
  effectPossible: z.boolean(),
  failure: githubFailureSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.resolvedTarget !== undefined && value.resolvedTarget.kind !== value.kind) {
    context.addIssue({ code: 'custom', message: 'mutation target kind disagrees with its stage' })
  }
  if (value.state === 'prepared') {
    if (value.effectPossible || value.failure !== undefined) {
      context.addIssue({ code: 'custom', message: 'prepared mutation stage contains effect evidence' })
    }
    return
  }
  if (value.resolvedTarget === undefined) {
    context.addIssue({ code: 'custom', message: 'started mutation stage lacks a concrete target' })
  }
  if (value.state !== 'confirmed' && value.state !== 'failed' && !value.effectPossible) {
    context.addIssue({ code: 'custom', message: 'started mutation stage must admit a possible effect' })
  }
  if (value.state === 'failed' && value.failure === undefined) {
    context.addIssue({ code: 'custom', message: 'failed mutation stage lacks failure evidence' })
  }
  if (value.state !== 'failed' && value.failure !== undefined) {
    context.addIssue({ code: 'custom', message: 'non-failed mutation stage contains failure evidence' })
  }
})

const workItemTargetedIssueFactSchema = z.object({
  id: githubIssueIdSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  title: githubSafeText,
  url: githubSafeUrl,
  updatedAt: timestamp,
}).strict()

const workItemTargetedProjectItemFactSchema = z.object({
  id: githubProjectItemIdSchema,
  projectId: githubProjectIdSchema,
  issueId: githubIssueIdSchema,
  statusOptionId: githubProjectOptionIdSchema.optional(),
  archived: z.boolean(),
  apiOrder: ordinal,
  previousItemId: githubProjectItemIdSchema.nullable(),
  nextItemId: githubProjectItemIdSchema.nullable(),
  totalCount: z.number().int().positive(),
  updatedAt: timestamp,
}).strict().superRefine((item, context) => {
  if (item.apiOrder >= item.totalCount) {
    context.addIssue({ code: 'custom', message: 'Project item order exceeds the complete connection' })
  }
  if ((item.apiOrder === 0) !== (item.previousItemId === null)) {
    context.addIssue({ code: 'custom', message: 'Project item previous neighbor disagrees with its complete position' })
  }
  if ((item.apiOrder === item.totalCount - 1) !== (item.nextItemId === null)) {
    context.addIssue({ code: 'custom', message: 'Project item next neighbor disagrees with its complete position' })
  }
  if (item.previousItemId === item.id || item.nextItemId === item.id
    || (item.previousItemId !== null && item.previousItemId === item.nextItemId)) {
    context.addIssue({ code: 'custom', message: 'Project item neighbors must be distinct' })
  }
})

const workItemTargetedFactsSchema = z.object({
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  projectId: githubProjectIdSchema,
  statusFieldId: githubProjectFieldIdSchema,
  issue: workItemTargetedIssueFactSchema,
  membership: z.discriminatedUnion('state', [
    z.object({ state: z.literal('present'), item: workItemTargetedProjectItemFactSchema }).strict(),
    z.object({ state: z.literal('absent') }).strict(),
  ]),
}).strict().superRefine((facts, context) => {
  if (facts.issue.repositoryId !== facts.repositoryId
    || facts.issue.repositoryDatabaseId !== facts.repositoryDatabaseId) {
    context.addIssue({ code: 'custom', message: 'targeted Issue ownership disagrees with Repository facts' })
  }
  if (facts.membership.state === 'present'
    && (facts.membership.item.projectId !== facts.projectId
      || facts.membership.item.issueId !== facts.issue.id)) {
    context.addIssue({ code: 'custom', message: 'targeted membership ownership disagrees with Work Item facts' })
  }
})

const githubWorkItemTargetedObservationSchema = z.object({
  stageMutationId: githubExternalOperationIdSchema,
  stageKind: z.literal('project-item-status-set'),
  workItemId: boardWorkItemId,
  remoteFingerprint: boardRemoteFingerprint,
  facts: workItemTargetedFactsSchema,
  observedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (value.workItemId !== deriveBoardWorkItemId(value.facts.repositoryId, value.facts.issue.id)) {
    context.addIssue({ code: 'custom', message: 'targeted Work Item id disagrees with observed Issue identity' })
  }
  if (value.remoteFingerprint !== targetedBoardRemoteFingerprint(value.facts)) {
    context.addIssue({ code: 'custom', message: 'targeted Work Item remote fingerprint is stale' })
  }
})

/** Parsed complete targeted observation used by a Status stage or final Board confirmation. */
export type GitHubWorkItemTargetedObservation = z.infer<typeof githubWorkItemTargetedObservationSchema>

const githubWorkItemPositionObservationSchema = z.object({
  stageMutationId: githubExternalOperationIdSchema,
  stageKind: z.literal('project-item-position-set'),
  workItemId: boardWorkItemId,
  facts: githubProjectItemPositionSnapshotSchema,
  observedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (value.workItemId !== deriveBoardWorkItemId(value.facts.repositoryId, value.facts.issue.id)) {
    context.addIssue({ code: 'custom', message: 'position Work Item id disagrees with observed Issue identity' })
  }
})

/** Parsed API-position observation retained in one stage prefix. */
export type GitHubWorkItemPositionObservation = z.infer<typeof githubWorkItemPositionObservationSchema>

const githubWorkItemPositionBoardObservationSchema = githubWorkItemPositionObservationSchema.superRefine(
  (observation, context) => {
    if (observation.facts.membership.state === 'duplicate-conflict') {
      context.addIssue({ code: 'custom', message: 'position Board evidence has duplicate Project memberships' })
    }
  },
)

const githubWorkItemBoardObservationSchema = z.union([
  githubWorkItemTargetedObservationSchema,
  githubWorkItemPositionBoardObservationSchema,
])

/** Complete targeted Board evidence produced by a Status or API-position inspection. */
export type GitHubWorkItemBoardObservation = z.infer<typeof githubWorkItemBoardObservationSchema>

const githubWorkItemIssueStateObservationSchema = z.object({
  stageMutationId: githubExternalOperationIdSchema,
  stageKind: z.literal('issue-state-set'),
  workItemId: boardWorkItemId,
  facts: githubIssueStateSnapshotSchema,
  observedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (value.workItemId !== deriveBoardWorkItemId(value.facts.issue.repositoryId, value.facts.issue.id)) {
    context.addIssue({ code: 'custom', message: 'Issue-state Work Item id disagrees with observed Issue identity' })
  }
})

const githubWorkItemMembershipObservationSchema = z.object({
  stageMutationId: githubExternalOperationIdSchema,
  stageKind: z.literal('project-item-add'),
  workItemId: boardWorkItemId,
  facts: githubProjectItemAddSnapshotSchema,
  observedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (value.workItemId !== deriveBoardWorkItemId(value.facts.repositoryId, value.facts.issue.id)) {
    context.addIssue({ code: 'custom', message: 'membership Work Item id disagrees with observed Issue identity' })
  }
})

const githubWorkItemIssueCreateObservationSchema = z.object({
  stageMutationId: githubExternalOperationIdSchema,
  stageKind: z.literal('issue-create'),
  workItemId: boardWorkItemId,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  markerId: createMarkerIdSchema,
  issue: workItemTargetedIssueFactSchema,
  observedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (value.issue.repositoryId !== value.repositoryId
    || value.issue.repositoryDatabaseId !== value.repositoryDatabaseId
    || value.workItemId !== deriveBoardWorkItemId(value.repositoryId, value.issue.id)) {
    context.addIssue({ code: 'custom', message: 'Issue-create observation ownership is inconsistent' })
  }
})

const githubWorkItemObservationSchema = z.discriminatedUnion('stageKind', [
  githubWorkItemIssueCreateObservationSchema,
  githubWorkItemMembershipObservationSchema,
  githubWorkItemTargetedObservationSchema,
  githubWorkItemPositionObservationSchema,
  githubWorkItemIssueStateObservationSchema,
])

const workItemTerminalEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('succeeded'),
    confirmedObservation: githubWorkItemBoardObservationSchema,
    confirmedAt: timestamp,
  }).strict(),
  z.object({
    kind: z.literal('conflict'),
    reason: z.enum(['expected-revision', 'stale-remote', 'mapping-repair-required']),
    confirmedObservation: githubWorkItemObservationSchema.optional(),
    confirmedAt: timestamp.optional(),
  }).strict().superRefine((value, context) => {
    const needsObservation = value.reason === 'stale-remote' || value.reason === 'mapping-repair-required'
    if (needsObservation !== (value.confirmedObservation !== undefined)
      || (value.confirmedObservation !== undefined) !== (value.confirmedAt !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Work Item conflict evidence disagrees with reason' })
    }
  }),
  z.object({
    kind: z.literal('reconciliation-required'),
    reason: z.enum(['effect-unknown', 'evidence-conflict', 'marker-ambiguous']),
    stageMutationId: githubExternalOperationIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('canceled'),
    reason: z.literal('authority-revoked'),
  }).strict(),
])

/** Strict durable create/move Work Item Intent with server-derived authority targets. */
export const githubWorkItemIntentRecordSchema = z.object({
  id: controlIntentId,
  schemaVersion: z.literal(1),
  revision,
  receiptId: intentReceiptId,
  payloadDigest: digest,
  payload: z.object({
    intent: githubWorkItemIntentSchema,
    actor: controlIntentActorSchema,
  }).strict(),
  target: githubWorkItemTargetSchema,
  phase: z.enum([
    'prepared',
    'running',
    'partial-failure',
    'succeeded',
    'conflict',
    'reconciliation-required',
    'canceled',
  ]),
  stages: z.array(workItemMutationStageSchema).min(1).max(4),
  observedPrefix: z.array(githubWorkItemObservationSchema).max(4),
  terminalEvidence: workItemTerminalEvidenceSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((value, context) => {
  refineDurableIntentIdentity(value, context)
  if (canonicalDigest('saki/github-work-item-intent/v1', value.payload) !== value.payloadDigest) {
    context.addIssue({ code: 'custom', message: 'Work Item Intent payload digest is stale', path: ['payloadDigest'] })
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'Work Item Intent time evidence is inconsistent' })
  }
  if (value.payload.intent.type !== value.target.kind) {
    context.addIssue({ code: 'custom', message: 'server-derived Work Item target disagrees with Intent kind' })
  }
  if (value.payload.intent.type === 'move-work-item') {
    /* v8 ignore next -- the preceding kind correlation already rejects a non-Move target. */
    if (value.target.kind !== 'move-work-item') return
    const intentPosition = value.payload.intent.position
    const targetPosition = value.target.position
    const positionsAgree = intentPosition === undefined
      ? targetPosition === undefined
      : intentPosition.afterWorkItemId === null
        ? targetPosition?.kind === 'top'
        : targetPosition?.kind === 'after'
          && targetPosition.workItemId === intentPosition.afterWorkItemId
          && targetPosition.expectedRemoteFingerprint === intentPosition.expectedAfterRemoteFingerprint
    if (!positionsAgree) {
      context.addIssue({ code: 'custom', message: 'server-derived position disagrees with Saki Intent' })
    }
  }
  const expectedStageKinds: readonly WorkItemMutationStageKind[] = (() => {
    if (value.target.kind === 'create-work-item') {
      return ['issue-create', 'project-item-add', 'project-item-status-set']
    }
    if (value.payload.intent.type !== 'move-work-item') return []
    const kinds: WorkItemMutationStageKind[] = []
    if (value.target.source.membership === 'absent') kinds.push('project-item-add')
    const desiredIssueState = value.payload.intent.targetStatus === 'done'
      || value.payload.intent.targetStatus === 'canceled'
      ? 'closed'
      : 'open'
    if (value.target.source.issueState === 'closed' && desiredIssueState === 'open') {
      kinds.push('issue-state-set')
    }
    kinds.push('project-item-status-set')
    if (value.target.position !== undefined) kinds.push('project-item-position-set')
    if (value.target.source.issueState === 'open' && desiredIssueState === 'closed') {
      kinds.push('issue-state-set')
    }
    return kinds
  })()
  if (!isDeepStrictEqual(value.stages.map(stage => stage.kind), expectedStageKinds)) {
    context.addIssue({ code: 'custom', message: 'Work Item stages disagree with the frozen mutation topology' })
  }
  const issueObservation = value.observedPrefix.find(observation => observation.stageKind === 'issue-create')
  const membershipObservation = value.observedPrefix.find(observation => observation.stageKind === 'project-item-add')
  const observedMembership = membershipObservation?.stageKind === 'project-item-add'
    && membershipObservation.facts.membership.state === 'present'
    ? membershipObservation.facts.membership.item
    : undefined
  if (value.target.kind === 'move-work-item') {
    if (value.target.source.membership === 'present') {
      if (value.target.projectItemId !== value.target.source.projectItemId) {
        context.addIssue({ code: 'custom', message: 'joined move target disagrees with its source Project item' })
      }
    } else {
      const confirmedItemId = observedMembership?.id
      if (value.target.projectItemId !== confirmedItemId) {
        context.addIssue({ code: 'custom', message: 'unjoined move target materializes without membership evidence' })
      }
    }
  }
  value.stages.forEach((stage) => {
    if (stage.mutationId !== githubWorkItemStageMutationId(value.id, stage.kind)) {
      context.addIssue({ code: 'custom', message: 'Work Item stage mutation id is not stable' })
    }
    const resolved = stage.resolvedTarget
    if (resolved === undefined) return
    if (!isDeepStrictEqual(resolved.installation, value.target.installation)
      || resolved.repositoryId !== value.target.repositoryId
      || resolved.repositoryDatabaseId !== value.target.repositoryDatabaseId) {
      context.addIssue({ code: 'custom', message: 'resolved mutation target disagrees with the frozen provider target' })
      return
    }
    if (resolved.kind === 'issue-create') {
      if (value.target.kind !== 'create-work-item' || resolved.markerId !== value.target.markerId) {
        context.addIssue({ code: 'custom', message: 'resolved Issue-create target disagrees with create material' })
      }
      if (value.payload.intent.type !== 'create-work-item'
        || resolved.titleDigest !== canonicalDigest('saki/work-item-issue-title/v1', {
          title: value.payload.intent.title,
        })
        || resolved.bodyDigest !== canonicalDigest('saki/work-item-issue-body/v1', {
          body: renderGitHubWorkItemIssueBody({
            intendedOutcome: value.payload.intent.intendedOutcome,
            acceptanceCriteria: value.payload.intent.acceptanceCriteria,
            markerId: resolved.markerId,
          }),
        })) {
        context.addIssue({ code: 'custom', message: 'resolved Issue-create content digest is stale' })
      }
      return
    }
    if (resolved.kind === 'project-item-add') {
      const expectedIssueId = value.target.kind === 'move-work-item'
        ? value.target.issueId
        : issueObservation?.stageKind === 'issue-create' ? issueObservation.issue.id : undefined
      if (resolved.projectId !== value.target.projectId || resolved.issueId !== expectedIssueId) {
        context.addIssue({ code: 'custom', message: 'resolved membership target lacks its confirmed Issue input' })
      }
      return
    }
    if (resolved.kind === 'project-item-status-set') {
      const expectedIssueId = value.target.kind === 'move-work-item'
        ? value.target.issueId
        : issueObservation?.stageKind === 'issue-create' ? issueObservation.issue.id : undefined
      const expectedProjectItemId = value.target.kind === 'move-work-item' && value.target.projectItemId !== undefined
        ? value.target.projectItemId
        : observedMembership?.id
      if (resolved.projectId !== value.target.projectId
        || resolved.issueId !== expectedIssueId
        || resolved.projectItemId !== expectedProjectItemId
        || resolved.statusFieldId !== value.target.statusFieldId
        || resolved.desiredStatusOptionId !== value.target.desiredStatusOptionId) {
        context.addIssue({ code: 'custom', message: 'resolved Status target lacks its confirmed stage inputs' })
      }
      return
    }
    if (resolved.kind === 'project-item-position-set') {
      if (value.target.kind !== 'move-work-item' || resolved.projectId !== value.target.projectId
        || resolved.issueId !== value.target.issueId || resolved.projectItemId !== value.target.projectItemId
        || resolved.statusFieldId !== value.target.statusFieldId
        || resolved.afterItemId !== (value.target.position?.kind === 'after'
          ? value.target.position.projectItemId
          : null)) {
        context.addIssue({ code: 'custom', message: 'resolved position target disagrees with move material' })
      }
      return
    }
    if (value.target.kind !== 'move-work-item' || resolved.issueId !== value.target.issueId) {
      context.addIssue({ code: 'custom', message: 'resolved Issue-state target disagrees with move material' })
    }
  })
  const mutationIds = value.stages.map(stage => stage.mutationId)
  if (new Set(mutationIds).size !== mutationIds.length) {
    context.addIssue({ code: 'custom', message: 'Work Item mutation ids must not repeat' })
  }
  value.observedPrefix.forEach((observation, index) => {
    const stage = value.stages[index]
    if (stage === undefined || stage.mutationId !== observation.stageMutationId
      || stage.kind !== observation.stageKind || stage.state !== 'confirmed') {
      context.addIssue({ code: 'custom', message: 'observed prefix does not match confirmed mutation stages' })
      return
    }
    const resolved = stage.resolvedTarget
    if (resolved === undefined) return
    if (observation.stageKind === 'issue-create') {
      if (resolved.kind !== 'issue-create' || observation.repositoryId !== resolved.repositoryId
        || observation.repositoryDatabaseId !== resolved.repositoryDatabaseId
        || observation.markerId !== resolved.markerId) {
        context.addIssue({ code: 'custom', message: 'Issue-create observation disagrees with its target' })
      }
      return
    }
    if (observation.stageKind === 'project-item-add') {
      const membership = observation.facts.membership
      const item = membership.state === 'present' ? membership.item : undefined
      if (resolved.kind !== 'project-item-add'
        || observation.facts.projectId !== resolved.projectId
        || observation.facts.issue.id !== resolved.issueId
        || item === undefined) {
        context.addIssue({ code: 'custom', message: 'membership observation does not confirm one exact Project item' })
      }
      return
    }
    if (observation.stageKind === 'project-item-status-set') {
      const facts = observation.facts
      const item = facts.membership.state === 'present' ? facts.membership.item : undefined
      /* v8 ignore next -- the stage schema already rejects a resolved target whose kind differs from its stage. */
      if (resolved.kind !== 'project-item-status-set') return
      const precedingIssueState = value.stages.slice(0, index)
        .find(candidate => candidate.resolvedTarget?.kind === 'issue-state-set')
        ?.resolvedTarget
      const expectedIssueState = precedingIssueState?.kind === 'issue-state-set'
        ? precedingIssueState.desiredState
        : value.target.kind === 'move-work-item'
          ? value.target.source.issueState
          : 'open'
      if (facts.projectId !== resolved.projectId || facts.issue.id !== resolved.issueId
        || facts.issue.state !== expectedIssueState || item?.id !== resolved.projectItemId
        || item.archived || item.statusOptionId !== resolved.desiredStatusOptionId) {
        context.addIssue({ code: 'custom', message: 'Status observation does not confirm the desired Work Item state' })
      }
      return
    }
    if (observation.stageKind === 'project-item-position-set') {
      const facts = observation.facts
      const item = facts.membership.state === 'present' ? facts.membership.item : undefined
      /* v8 ignore next -- the stage schema already rejects a resolved target whose kind differs from its stage. */
      if (resolved.kind !== 'project-item-position-set') return
      const predecessorMatches = resolved.afterItemId === null
        ? facts.after.state === 'top'
        : facts.after.state === 'present' && facts.after.item.id === resolved.afterItemId
      if (facts.projectId !== resolved.projectId || facts.issue.id !== resolved.issueId
        || facts.statusFieldId !== resolved.statusFieldId
        || item?.id !== resolved.projectItemId || item.previousItemId !== resolved.afterItemId
        || item.archived || !predecessorMatches) {
        context.addIssue({ code: 'custom', message: 'position observation does not confirm the requested API position' })
      }
      return
    }
    if (resolved.kind !== 'issue-state-set'
      || observation.facts.issue.id !== resolved.issueId
      || observation.facts.issue.state !== resolved.desiredState) {
      context.addIssue({ code: 'custom', message: 'Issue-state observation does not confirm the requested state' })
    }
  })
  if (value.stages.slice(value.observedPrefix.length).some(stage => stage.state === 'confirmed')) {
    context.addIssue({ code: 'custom', message: 'confirmed mutation stages must form the observed prefix' })
  }
  const frontier = value.stages[value.observedPrefix.length]
  if (value.stages.slice(value.observedPrefix.length + 1).some(stage => stage.state !== 'prepared')) {
    context.addIssue({ code: 'custom', message: 'Work Item stages after the active frontier must remain prepared' })
  }
  if (value.stages.some(stage => stage.kind === 'issue-create'
    && stage.state === 'confirmed' && !stage.effectPossible)) {
    context.addIssue({ code: 'custom', message: 'Issue creation cannot be confirmed before its effect became possible' })
  }
  const activeStages = value.stages.filter(stage => stage.state === 'dispatching')
  const failedStages = value.stages.filter(stage => stage.state === 'failed')
  if (activeStages.length > 1 || failedStages.length > 1 || activeStages.length + failedStages.length > 1) {
    context.addIssue({ code: 'custom', message: 'Work Item mutation topology has multiple active frontiers' })
  }
  if (value.phase === 'prepared') {
    if (frontier?.state !== 'prepared' || activeStages.length > 0 || failedStages.length > 0
      || value.terminalEvidence !== undefined) {
      context.addIssue({ code: 'custom', message: 'prepared Work Item Intent lacks one safe stage frontier' })
    }
  } else if (value.phase === 'running') {
    if (frontier?.state !== 'dispatching' || activeStages.length !== 1
      || failedStages.length > 0 || value.terminalEvidence !== undefined) {
      context.addIssue({ code: 'custom', message: 'running Work Item Intent lacks one active stage' })
    }
  } else if (value.phase === 'partial-failure') {
    if (frontier?.state !== 'failed' || failedStages.length !== 1
      || activeStages.length > 0 || value.terminalEvidence !== undefined) {
      context.addIssue({ code: 'custom', message: 'partial Work Item failure disagrees with failed stage' })
    }
  } else {
    if (value.terminalEvidence?.kind !== value.phase) {
      context.addIssue({ code: 'custom', message: 'terminal Work Item evidence disagrees with phase' })
    }
    if (value.phase === 'succeeded') {
      const finalObservation = value.observedPrefix.at(-1)
      const confirmedObservation = value.terminalEvidence?.kind === 'succeeded'
        ? value.terminalEvidence.confirmedObservation
        : undefined
      const finalEvidenceCurrent = finalObservation?.stageKind === 'project-item-status-set'
        || finalObservation?.stageKind === 'project-item-position-set'
        ? isDeepStrictEqual(finalObservation, confirmedObservation)
        : finalObservation !== undefined && confirmedObservation !== undefined
          && finalObservation.workItemId === confirmedObservation.workItemId
          && confirmedObservation.observedAt >= finalObservation.observedAt
      const moveFinalStateCurrent = (() => {
        if (value.target.kind !== 'move-work-item' || value.payload.intent.type !== 'move-work-item') return true
        if (confirmedObservation === undefined) return false
        const facts = confirmedObservation.facts
        const item = facts.membership.state === 'present' ? facts.membership.item : undefined
        if (item === undefined) return false
        const expectedIssueState = value.payload.intent.targetStatus === 'done'
          || value.payload.intent.targetStatus === 'canceled'
          ? 'closed'
          : 'open'
        if (confirmedObservation.workItemId !== value.payload.intent.workItemId
          || facts.repositoryId !== value.target.repositoryId
          || facts.repositoryDatabaseId !== value.target.repositoryDatabaseId
          || facts.projectId !== value.target.projectId
          || facts.statusFieldId !== value.target.statusFieldId
          || facts.issue.id !== value.target.issueId
          || facts.issue.state !== expectedIssueState
          || item.id !== value.target.projectItemId
          || item.archived
          || item.statusOptionId !== value.target.desiredStatusOptionId) return false
        const position = value.target.position
        if (position === undefined) return confirmedObservation.stageKind === 'project-item-status-set'
        if (confirmedObservation.stageKind !== 'project-item-position-set') return false
        if (position.kind === 'top') {
          return confirmedObservation.facts.after.state === 'top'
            && item.apiOrder === 0
            && item.previousItemId === null
        }
        const after = confirmedObservation.facts.after
        return after.state === 'present'
          && after.item.id === position.projectItemId
          && !after.item.archived
          && after.item.statusOptionId === value.target.desiredStatusOptionId
          && item.previousItemId === after.item.id
          && after.item.nextItemId === item.id
          && item.apiOrder === after.item.apiOrder + 1
          && item.totalCount === after.item.totalCount
      })()
      if (value.stages.some(stage => stage.state !== 'confirmed')
        || value.observedPrefix.length !== value.stages.length
        || value.terminalEvidence?.kind !== 'succeeded'
        || !finalEvidenceCurrent
        || !moveFinalStateCurrent
        || value.terminalEvidence.confirmedAt < value.terminalEvidence.confirmedObservation.observedAt) {
        context.addIssue({ code: 'custom', message: 'succeeded Work Item Intent lacks final confirmed evidence' })
      }
    }
    if (value.phase === 'reconciliation-required'
      && value.terminalEvidence?.kind === 'reconciliation-required') {
      const { stageMutationId } = value.terminalEvidence
      const stage = value.stages.find(candidate => candidate.mutationId === stageMutationId)
      const markerAmbiguousBeforeDispatch = value.terminalEvidence.reason === 'marker-ambiguous'
        && stage?.kind === 'issue-create'
      if (stage === undefined || (!markerAmbiguousBeforeDispatch && !stage.effectPossible)) {
        context.addIssue({ code: 'custom', message: 'reconciliation does not identify an effect-possible stage' })
      }
    }
  }
})

/** Parsed durable Work Item Intent. */
export type GitHubWorkItemIntentRecord = z.infer<typeof githubWorkItemIntentRecordSchema>

/** Strict per-Work-Item targeted recovery state, separate from complete Board checkpoints. */
export const githubWorkItemRecoveryRecordSchema = z.object({
  id: workItemRecoveryId,
  workItemId: boardWorkItemId,
  schemaVersion: z.literal(1),
  revision,
  projectId: developmentProjectId,
  latestNonTerminalStatus: nonTerminalBoardStatusSchema.nullable(),
  confirmed: z.object({
    sourceIntentId: controlIntentId,
    observation: githubWorkItemBoardObservationSchema,
    confirmedAt: timestamp,
  }).strict(),
  updatedAt: timestamp,
}).strict().superRefine((value, context) => {
  const confirmed = value.confirmed
  if (value.id !== githubWorkItemRecoveryId(value.projectId, value.workItemId)) {
    context.addIssue({
      code: 'custom',
      message: 'Work Item recovery id disagrees with its Development Project scope',
      path: ['id'],
    })
  }
  if (confirmed.observation.workItemId !== value.workItemId
    || confirmed.confirmedAt < confirmed.observation.observedAt
    || confirmed.confirmedAt > value.updatedAt) {
    context.addIssue({ code: 'custom', message: 'confirmed recovery observation is inconsistent' })
  }
})

/** Parsed per-Work-Item targeted recovery record. */
export type GitHubWorkItemRecoveryRecord = z.infer<typeof githubWorkItemRecoveryRecordSchema>

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
  latestNonTerminalStatus: nonTerminalBoardStatusSchema.nullable(),
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
  const expectedId = `work-item-${canonicalDigest('saki/board-work-item/v1', {
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
  if (value.status !== 'done' && value.status !== 'canceled'
    && value.latestNonTerminalStatus !== value.status) {
    context.addIssue({ code: 'custom', message: 'non-terminal Work Item must remember its current Status' })
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
export const githubProjectSyncRecordSchema = z.object({
  id: developmentProjectId,
  schemaVersion: z.literal(2),
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

/** Parsed durable per-Project GitHub synchronization aggregate. */
export type GitHubProjectSyncRecord = z.infer<typeof githubProjectSyncRecordSchema>

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
export const githubSynchronizationConfigurationIntentRecordSchema = githubConfigurationIntentRecordBaseSchema
  .superRefine((value, context) => {
    refineDurableIntentIdentity(value, context)
    if (canonicalDigest('saki/configure-github-synchronization/v1', value.payload) !== value.payloadDigest) {
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

/** Parsed durable GitHub synchronization configuration Intent. */
export type GitHubSynchronizationConfigurationIntentRecord = z.infer<
  typeof githubSynchronizationConfigurationIntentRecordSchema
>

const gitOperationIntentSchema = z.discriminatedUnion('type', [
  stageFilesIntentSchema,
  unstageFilesIntentSchema,
  createCommitIntentSchema,
])

/** Closed current lifecycle for one structured Git Control Intent. */
export const gitOperationIntentPhaseSchema = z.enum([
  'prepared',
  'admission-reserved',
  'host-prepared',
  'accepted',
  'succeeded',
  'conflict',
  'failed',
  'canceled',
  'reconciliation-required',
])

const gitHostOperationRequestSchema = z.discriminatedUnion('type', [
  stageFilesHostOperationRequestSchema,
  unstageFilesHostOperationRequestSchema,
  commitHostOperationRequestSchema,
])

/** Safe terminal classifications retained with a structured Git Intent. */
export const gitOperationTerminalReasonSchema = z.enum([
  'expected-evidence',
  'invalid-selection',
  'source-conflict',
  'authority-revoked',
  'binding-stale',
  'observation-stale',
  'unsupported-state',
  'source-canceled',
  'effect-unknown',
  'evidence-conflict',
  'protocol',
])

/** Unified durable StageFiles, UnstageFiles, and CreateCommit Intent record. */
export const gitOperationIntentRecordSchema = z.object({
  id: controlIntentId,
  schemaVersion: z.literal(1),
  revision,
  receiptId: intentReceiptId,
  payloadDigest: digest,
  payload: z.object({
    intent: gitOperationIntentSchema,
    actor: controlIntentActorSchema,
  }).strict(),
  requestRevision: revision,
  hostRequest: gitHostOperationRequestSchema.optional(),
  phase: gitOperationIntentPhaseSchema,
  reservationRevision: revision.optional(),
  preparation: hostOperationPreparationSchema.optional(),
  admissionRevision: revision.optional(),
  operationSnapshot: hostOperationSnapshotSchema.optional(),
  terminalReason: gitOperationTerminalReasonSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((value, context) => {
  refineDurableIntentIdentity(value, context)
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'Intent update predates creation', path: ['updatedAt'] })
  }
  if (canonicalDigest('saki/git-operation-intent/v1', value.payload) !== value.payloadDigest) {
    context.addIssue({ code: 'custom', message: 'Intent payload digest is stale', path: ['payloadDigest'] })
  }
  const hostRequest = value.hostRequest
  const hasReservation = value.reservationRevision !== undefined
  const hasPreparation = value.preparation !== undefined
  const hasAdmission = value.admissionRevision !== undefined
  const hasSnapshot = value.operationSnapshot !== undefined
  const terminalWithReason = value.phase === 'conflict' || value.phase === 'failed' || value.phase === 'canceled'
    || value.phase === 'reconciliation-required'
  if (hostRequest === undefined) {
    if (value.phase !== 'conflict'
      || (value.terminalReason !== 'expected-evidence' && value.terminalReason !== 'invalid-selection')
      || hasReservation || hasPreparation || hasAdmission || hasSnapshot) {
      context.addIssue({ code: 'custom', message: 'pre-Host Git Intent conflict has invalid evidence' })
    }
    if (terminalWithReason !== (value.terminalReason !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Git Intent terminal reason disagrees with phase' })
    }
    return
  }
  const source = hostRequest.source
  if (source.intentId !== value.id || source.intentRevision !== value.requestRevision
    || source.payloadDigest !== value.payloadDigest) {
    context.addIssue({ code: 'custom', message: 'Host request source disagrees with its Intent' })
  }
  const expected = value.payload.intent.expected
  if (hostRequest.expected.binding.id !== expected.expectedBinding.id
    || hostRequest.expected.binding.revision !== expected.expectedBinding.revision
    || !isDeepStrictEqual(hostRequest.expected.status, expected.expectedStatus)
    || !isDeepStrictEqual(hostRequest.expected.head, expected.expectedHead)
    || !isDeepStrictEqual(hostRequest.expected.index, expected.expectedIndex)
    || !isDeepStrictEqual(hostRequest.expected.worktree, expected.expectedWorktree)) {
    context.addIssue({ code: 'custom', message: 'Host request evidence disagrees with its Intent' })
  }
  const expectedHostType = value.payload.intent.type === 'create-commit' ? 'commit' : value.payload.intent.type
  if (hostRequest.type !== expectedHostType) {
    context.addIssue({ code: 'custom', message: 'Host request kind disagrees with its Intent' })
  } else if (value.payload.intent.type === 'create-commit' && hostRequest.type === 'commit') {
    if (value.payload.intent.message !== hostRequest.message) {
      context.addIssue({ code: 'custom', message: 'Host request message disagrees with its Intent' })
    }
  } else if (value.payload.intent.type !== 'create-commit' && hostRequest.type !== 'commit'
    && !isDeepStrictEqual(value.payload.intent.changes, hostRequest.changes)) {
    context.addIssue({ code: 'custom', message: 'Host request selection disagrees with its Intent' })
  }
  if (value.payload.actor.hostId !== hostRequest.expected.binding.hostId) {
    context.addIssue({ code: 'custom', message: 'Git operation actor belongs to another Host' })
  }
  if (value.phase === 'prepared' && (hasReservation || hasPreparation || hasAdmission || hasSnapshot)) {
    context.addIssue({ code: 'custom', message: 'prepared Git Intent retains later-phase evidence' })
  }
  if (value.phase === 'admission-reserved' && (!hasReservation || hasPreparation || hasAdmission || hasSnapshot)) {
    context.addIssue({ code: 'custom', message: 'reserved Git Intent has invalid phase evidence' })
  }
  if (value.phase === 'host-prepared' && (!hasReservation || !hasPreparation || hasAdmission || !hasSnapshot)) {
    context.addIssue({ code: 'custom', message: 'Host-prepared Git Intent has invalid phase evidence' })
  }
  if (value.phase === 'host-prepared' && value.operationSnapshot?.state !== 'prepared') {
    context.addIssue({ code: 'custom', message: 'Host-prepared Git Intent has advanced Host evidence' })
  }
  if ((value.phase === 'accepted' || value.phase === 'succeeded')
    && (!hasReservation || !hasPreparation || !hasAdmission || !hasSnapshot)) {
    context.addIssue({ code: 'custom', message: 'accepted Git Intent has incomplete operation evidence' })
  }
  if (value.phase === 'accepted' && value.operationSnapshot !== undefined
    && value.operationSnapshot.state !== 'prepared'
    && value.operationSnapshot.state !== 'accepted'
    && value.operationSnapshot.state !== 'planning'
    && value.operationSnapshot.state !== 'publishing') {
    context.addIssue({ code: 'custom', message: 'accepted Git Intent retains terminal Host evidence' })
  }
  if (value.phase === 'conflict') {
    const validWithoutHost = !hasPreparation && !hasAdmission && !hasSnapshot
    const validPreparedNoEffect = hasReservation && hasPreparation && !hasAdmission
      && hasSnapshot && value.operationSnapshot?.state === 'prepared'
    if (!validWithoutHost && !validPreparedNoEffect) {
      context.addIssue({ code: 'custom', message: 'conflicted Git Intent has possible-effect evidence' })
    }
    if (value.terminalReason !== 'expected-evidence'
      && value.terminalReason !== 'invalid-selection'
      && value.terminalReason !== 'source-conflict'
      && value.terminalReason !== 'protocol') {
      context.addIssue({ code: 'custom', message: 'conflicted Git Intent has an invalid reason' })
    }
    if (value.terminalReason === 'expected-evidence' || value.terminalReason === 'invalid-selection') {
      context.addIssue({ code: 'custom', message: 'pre-Host Git Intent conflict retains a Host request' })
    }
  }
  if ((value.phase === 'failed' || value.phase === 'canceled')
    && ((hasPreparation || hasAdmission || hasSnapshot)
      && (!hasReservation || !hasPreparation || !hasSnapshot))) {
    context.addIssue({ code: 'custom', message: 'no-effect Git Intent has partial Host evidence' })
  }
  if (value.phase === 'canceled'
    && value.terminalReason !== 'source-canceled'
    && value.terminalReason !== 'authority-revoked') {
    context.addIssue({ code: 'custom', message: 'canceled Git Intent has an invalid reason' })
  }
  if (value.phase === 'reconciliation-required'
    && (!hasReservation || !hasPreparation || !hasAdmission || !hasSnapshot
      || value.operationSnapshot?.state !== 'reconciliation-required')) {
    context.addIssue({ code: 'custom', message: 'reconciliation Git Intent has incomplete unknown-effect evidence' })
  }
  if (value.preparation !== undefined && value.operationSnapshot !== undefined
    && (value.preparation.operation.id !== value.operationSnapshot.operation.id
      || value.preparation.operation.hostId !== value.operationSnapshot.operation.hostId
      || value.preparation.operation.type !== value.operationSnapshot.operation.type
      || !isDeepStrictEqual(value.preparation.requestFingerprint, value.operationSnapshot.requestFingerprint))) {
    context.addIssue({ code: 'custom', message: 'Git Intent preparation disagrees with Host snapshot' })
  }
  if (value.operationSnapshot !== undefined
    && (value.operationSnapshot.source.kind !== 'control-intent'
      || value.operationSnapshot.source.intentId !== value.id
      || value.operationSnapshot.source.intentRevision !== value.requestRevision
      || value.operationSnapshot.source.payloadDigest !== value.payloadDigest
      || value.operationSnapshot.bindingId !== expected.expectedBinding.id
      || value.operationSnapshot.bindingRevision !== expected.expectedBinding.revision)) {
    context.addIssue({ code: 'custom', message: 'Host snapshot disagrees with its Git Intent' })
  }
  if (value.operationSnapshot?.admission.kind === 'accepted'
    && value.admissionRevision !== value.operationSnapshot.admission.revision) {
    context.addIssue({ code: 'custom', message: 'Git Intent admission revision disagrees with Host evidence' })
  }
  if ((value.phase === 'failed' || value.phase === 'canceled')
    && value.operationSnapshot?.admission.kind !== 'accepted'
    && value.admissionRevision !== undefined) {
    context.addIssue({ code: 'custom', message: 'no-effect Git Intent retains an unproven admission revision' })
  }
  if (terminalWithReason !== (value.terminalReason !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Git Intent terminal reason disagrees with phase' })
  }
  if (value.phase === 'succeeded' && value.operationSnapshot?.state !== 'succeeded') {
    context.addIssue({ code: 'custom', message: 'succeeded Git Intent lacks a succeeded Host snapshot' })
  }
  if (value.phase === 'failed' && value.operationSnapshot?.state !== 'failed') {
    context.addIssue({ code: 'custom', message: 'failed Git Intent lacks a failed Host snapshot' })
  }
  if (value.phase === 'failed' && value.operationSnapshot?.state === 'failed'
    && value.terminalReason !== value.operationSnapshot.failure.reason) {
    context.addIssue({ code: 'custom', message: 'failed Git Intent reason disagrees with Host evidence' })
  }
  if (value.phase === 'canceled' && value.operationSnapshot !== undefined
    && value.operationSnapshot.state !== 'canceled') {
    context.addIssue({ code: 'custom', message: 'canceled Git Intent lacks a canceled Host snapshot' })
  }
  if (value.phase === 'canceled' && value.operationSnapshot?.state === 'canceled'
    && value.terminalReason !== value.operationSnapshot.reason) {
    context.addIssue({ code: 'custom', message: 'canceled Git Intent reason disagrees with Host evidence' })
  }
  if (value.phase === 'reconciliation-required'
    && value.operationSnapshot?.state === 'reconciliation-required'
    && value.terminalReason !== value.operationSnapshot.reason) {
    context.addIssue({ code: 'custom', message: 'reconciliation reason disagrees with Host evidence' })
  }
})

/** Parsed durable structured Git Intent. */
export type GitOperationIntentRecord = z.infer<typeof gitOperationIntentRecordSchema>

const frozenWorkItemDefinitionSchema = z.object({
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  issueId: githubIssueIdSchema,
  issueNumber: z.number().int().positive(),
  issueState: z.literal('open'),
  title: githubSafeText,
  url: githubSafeUrl,
  body: z.string().max(256 * 1024).refine(value => value.isWellFormed()
    && !value.includes('\0')
    && new TextEncoder().encode(value).byteLength <= 256 * 1024),
  updatedAt: timestamp,
  remoteFingerprint: boardRemoteFingerprint,
  intendedOutcome: z.string().min(1).max(32_768),
  acceptanceCriteria: z.array(z.string().min(1).max(4_096)).min(1).max(128),
  blockage: z.array(z.string().min(1).max(4_096)).max(128),
}).strict()

const frozenAgentProfileSchema = z.object({
  id: agentProfileId,
  version: positiveRevision,
  agentPresetId,
  modelRoute: agentModelRouteRequestSchema,
}).strict()

/** Durable accepted manual Give-to-Agent Intent and all preallocated child identities. */
export const agentOperationIntentRecordSchema = z.object({
  id: controlIntentId,
  schemaVersion: z.literal(1),
  revision,
  receiptId: intentReceiptId,
  payloadDigest: digest,
  payload: z.object({
    intent: giveWorkItemToAgentIntentSchema,
    actor: controlIntentActorSchema,
  }).strict(),
  phase: z.enum([
    'prepared',
    'admission-reserved',
    'dispatching',
    'started',
    'canceled',
    'reconciliation-required',
  ]),
  assignmentId: workAssignmentId,
  workSessionId: sakiWorkSessionIdSchema,
  agentRunId: sakiAgentRunIdSchema,
  dispatchId: sakiExecutionDispatchIdSchema,
  inProgressIntentId: controlIntentId,
  workItemDefinition: frozenWorkItemDefinitionSchema,
  projectContext: z.object({
    projectId: developmentProjectId,
    projectRevision: revision,
    projectTitle,
    resourceBindingId,
    bindingRevision: revision,
  }).strict(),
  profile: frozenAgentProfileSchema,
  contextDigest: digest,
  hostRequest: startAgentRunHostOperationRequestV2Schema,
  terminalReason: z.enum([
    'authority-revoked',
    'effect-unknown',
    'evidence-conflict',
    'protocol',
  ]).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((value, context) => {
  refineDurableIntentIdentity(value, context)
  if (canonicalDigest('saki/agent-operation-intent/v1', value.payload) !== value.payloadDigest) {
    context.addIssue({ code: 'custom', message: 'Agent operation Intent payload digest is stale' })
  }
  if (canonicalDigest('saki/agent-operation-context/v1', {
    workItemDefinition: value.workItemDefinition,
    projectContext: value.projectContext,
    profile: value.profile,
  }) !== value.contextDigest) {
    context.addIssue({ code: 'custom', message: 'Agent operation frozen context digest is stale' })
  }
  const request = value.hostRequest
  if (request.source.dispatchId !== value.dispatchId
    || request.run.agentRunId !== value.agentRunId
    || request.run.workSessionId !== value.workSessionId
    || !isDeepStrictEqual(request.run.profile, value.profile)
    || request.expected.binding.id !== value.projectContext.resourceBindingId
    || request.expected.binding.revision !== value.projectContext.bindingRevision) {
    context.addIssue({ code: 'custom', message: 'Agent operation Intent child identities are inconsistent' })
  }
  const terminal = value.phase === 'canceled' || value.phase === 'reconciliation-required'
  if (terminal !== (value.terminalReason !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Agent operation terminal reason disagrees with phase' })
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'Agent operation timestamps are not monotonic' })
  }
})

/** Parsed durable manual Give-to-Agent Intent. */
export type AgentOperationIntentRecord = z.infer<typeof agentOperationIntentRecordSchema>

/** Exact durable Work Assignment retained for v7 migration input. */
export const workAssignmentV1RecordSchema = z.object({
  id: workAssignmentId,
  schemaVersion: z.literal(1),
  revision,
  intentId: controlIntentId,
  projectId: developmentProjectId,
  workItemId: boardWorkItemId,
  primaryWorkSessionId: sakiWorkSessionIdSchema,
  agentRunId: sakiAgentRunIdSchema,
  state: z.enum(['assigned', 'active', 'canceled', 'reconciliation-required']),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().refine(value => value.updatedAt >= value.createdAt, 'Assignment timestamps are not monotonic')

/** Durable Work Assignment with an explicit responsible Principal. */
export const workAssignmentRecordSchema = z.object({
  id: workAssignmentId,
  schemaVersion: z.literal(2),
  revision,
  intentId: controlIntentId,
  projectId: developmentProjectId,
  workItemId: boardWorkItemId,
  ownerPrincipalId: principalId,
  primaryWorkSessionId: sakiWorkSessionIdSchema,
  agentRunId: sakiAgentRunIdSchema,
  state: z.enum(['assigned', 'active', 'canceled', 'reconciliation-required']),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().refine(value => value.updatedAt >= value.createdAt, 'Assignment timestamps are not monotonic')

/** Parsed durable Work Assignment. */
export type WorkAssignmentRecord = z.infer<typeof workAssignmentRecordSchema>

/** Durable user-visible primary Work Session across Agent Run attempts. */
export const workSessionRecordSchema = z.object({
  id: sakiWorkSessionIdSchema,
  schemaVersion: z.literal(1),
  revision,
  intentId: controlIntentId,
  assignmentId: workAssignmentId,
  projectId: developmentProjectId,
  workItemId: boardWorkItemId,
  primary: z.literal(true),
  agentRunIds: z.array(sakiAgentRunIdSchema).min(1).max(32),
  state: z.enum(['open', 'canceled', 'reconciliation-required']),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (new Set(value.agentRunIds).size !== value.agentRunIds.length) {
    context.addIssue({ code: 'custom', message: 'Work Session repeats Agent Run ids' })
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'Work Session timestamps are not monotonic' })
  }
})

/** Parsed durable Work Session. */
export type WorkSessionRecord = z.infer<typeof workSessionRecordSchema>

const sessionId = z.string().regex(/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
const runInputPlanSchema = z.object({
  messageId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  payloadDigest: digest,
}).strict()

/** Exact durable Agent Run retained for v7 migration input. */
export const agentRunV1RecordSchema = z.object({
  id: sakiAgentRunIdSchema,
  schemaVersion: z.literal(1),
  revision,
  intentId: controlIntentId,
  assignmentId: workAssignmentId,
  workSessionId: sakiWorkSessionIdSchema,
  projectId: developmentProjectId,
  workItemId: boardWorkItemId,
  bindingId: resourceBindingId,
  profile: frozenAgentProfileSchema,
  sessionId,
  inputPlan: runInputPlanSchema,
  dispatchIds: z.array(sakiExecutionDispatchIdSchema).min(1).max(32),
  state: z.enum(['allocated', 'starting', 'running', 'canceled', 'reconciliation-required']),
  hostResult: startAgentRunHostOperationResultSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (new Set(value.dispatchIds).size !== value.dispatchIds.length) {
    context.addIssue({ code: 'custom', message: 'Agent Run repeats Dispatch ids' })
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'Agent Run timestamps are not monotonic' })
  }
  if (value.hostResult !== undefined
    && (value.hostResult.agentRunId !== value.id
      || value.hostResult.workSessionId !== value.workSessionId
      || value.hostResult.sessionId !== value.sessionId
      || value.hostResult.inputMessageId !== value.inputPlan.messageId)) {
    context.addIssue({ code: 'custom', message: 'Agent Run Host result disagrees with its exact input plan' })
  }
  if ((value.state === 'running') !== (value.hostResult !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Agent Run Host result disagrees with state' })
  }
})

/** Parsed exact Agent Run retained by `saki_control_plane@7`. */
export type AgentRunV1Record = z.infer<typeof agentRunV1RecordSchema>

/** Durable Agent Run allocation, exclusive Intervention blocker, and ordered Dispatch association. */
export const agentRunRecordSchema = z.object({
  id: sakiAgentRunIdSchema,
  schemaVersion: z.literal(2),
  revision,
  intentId: controlIntentId,
  assignmentId: workAssignmentId,
  workSessionId: sakiWorkSessionIdSchema,
  projectId: developmentProjectId,
  workItemId: boardWorkItemId,
  bindingId: resourceBindingId,
  profile: frozenAgentProfileSchema,
  sessionId,
  inputPlan: runInputPlanSchema,
  dispatchIds: z.array(sakiExecutionDispatchIdSchema).min(1).max(MAX_AGENT_RUN_DISPATCHES),
  state: z.enum([
    'allocated',
    'starting',
    'running',
    'waiting',
    'resume-pending',
    'canceled',
    'reconciliation-required',
  ]),
  blockingInterventionId: interventionRequestId.optional(),
  hostResult: startAgentRunHostOperationResultSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (new Set(value.dispatchIds).size !== value.dispatchIds.length) {
    context.addIssue({ code: 'custom', message: 'Agent Run repeats Dispatch ids' })
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'Agent Run timestamps are not monotonic' })
  }
  if (value.hostResult !== undefined
    && (value.hostResult.agentRunId !== value.id
      || value.hostResult.workSessionId !== value.workSessionId
      || value.hostResult.sessionId !== value.sessionId
      || value.hostResult.inputMessageId !== value.inputPlan.messageId)) {
    context.addIssue({ code: 'custom', message: 'Agent Run Host result disagrees with its exact input plan' })
  }
  const delivered = value.state === 'running' || value.state === 'waiting'
  if (delivered !== (value.hostResult !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Agent Run Host result disagrees with state' })
  }
  const blocked = value.blockingInterventionId !== undefined
  if ((value.state === 'waiting' || value.state === 'resume-pending') !== blocked
    && value.state !== 'reconciliation-required') {
    context.addIssue({ code: 'custom', message: 'Agent Run Intervention blocker disagrees with state' })
  }
})

/** Parsed durable Agent Run. */
export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>

const interventionRequiredAnswerSchema = z.object({
  kind: z.literal('text'),
  prompt: z.string()
    .min(1)
    .max(MAX_INTERVENTION_PROMPT_CHARS)
    .refine(value => value.isWellFormed() && !/[\u0000\u007f]/u.test(value)),
  maxLength: z.number().int().positive().max(MAX_INTERVENTION_ANSWER_CHARS),
}).strict()

const interventionOwnerSchema = z.object({
  kind: z.literal('agent-run'),
  agentRunId: sakiAgentRunIdSchema,
  workSessionId: sakiWorkSessionIdSchema,
}).strict()

const interventionSubjectSchema = z.object({
  kind: z.literal('agent-run'),
  agentRunId: sakiAgentRunIdSchema,
}).strict()

const interventionBlockingScopeSchema = z.object({
  kind: z.literal('agent-run'),
  agentRunId: sakiAgentRunIdSchema,
}).strict()

const interventionCauseSchema = z.object({
  kind: z.literal('agent-request'),
  agentRunId: sakiAgentRunIdSchema,
  workSessionId: sakiWorkSessionIdSchema,
  sessionId,
  toolCallId: z.string().min(1).max(200)
    .refine(value => value.isWellFormed() && !value.includes('\0'))
    .transform(value => CallId(value)),
}).strict()

const sakiReturnAddressSchema = z.object({
  kind: z.literal('agent-run'),
  projectId: developmentProjectId,
  workItemId: boardWorkItemId,
  workSessionId: sakiWorkSessionIdSchema,
  agentRunId: sakiAgentRunIdSchema,
}).strict()

const interventionAnswerWinnerSchema = z.object({
  receiptId: intentReceiptId,
  payloadDigest: digest,
  payload: z.object({
    intent: answerInterventionIntentSchema,
    actor: controlIntentActorSchema,
  }).strict(),
  acceptedAt: timestamp,
  dispatchId: sakiExecutionDispatchIdSchema,
  inputPlan: runInputPlanSchema,
}).strict()

const interventionRecordSharedShape = {
  id: interventionRequestId,
  schemaVersion: z.literal(1),
  revision,
  kind: z.literal('text-input'),
  projectId: developmentProjectId,
  owner: interventionOwnerSchema,
  subject: interventionSubjectSchema,
  targetPrincipalId: principalId,
  requiredAnswer: interventionRequiredAnswerSchema,
  blockingScope: interventionBlockingScopeSchema,
  cause: interventionCauseSchema,
  returnAddress: sakiReturnAddressSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const

const interventionRequestRecordVariants = [
  z.object({ ...interventionRecordSharedShape, state: z.literal('opening') }).strict(),
  z.object({ ...interventionRecordSharedShape, state: z.literal('open'), openedAt: timestamp }).strict(),
  z.object({
    ...interventionRecordSharedShape,
    state: z.literal('answered'),
    openedAt: timestamp,
    answer: interventionAnswerWinnerSchema,
  }).strict(),
  z.object({
    ...interventionRecordSharedShape,
    state: z.literal('resolved'),
    openedAt: timestamp,
    answer: interventionAnswerWinnerSchema,
    resolvedAt: timestamp,
  }).strict(),
  z.object({
    ...interventionRecordSharedShape,
    state: z.literal('reconciliation-required'),
    openedAt: timestamp,
    answer: interventionAnswerWinnerSchema.optional(),
    reason: z.enum(['effect-unknown', 'evidence-conflict', 'protocol']),
    reconciliationRequiredAt: timestamp,
  }).strict(),
] as const

/** Durable request for one independently answerable Host Operator action. */
export const interventionRequestRecordSchema = z.union(interventionRequestRecordVariants)
  .superRefine((value, context) => {
    if (value.updatedAt < value.createdAt
      || ('openedAt' in value
        && (value.openedAt < value.createdAt || value.openedAt > value.updatedAt))
      || (value.state === 'reconciliation-required'
        && (value.reconciliationRequiredAt < value.createdAt
          || value.reconciliationRequiredAt > value.updatedAt))) {
      context.addIssue({ code: 'custom', message: 'Intervention Request timestamps are not monotonic' })
    }
    if (value.returnAddress.projectId !== value.projectId) {
      context.addIssue({ code: 'custom', message: 'Intervention return address belongs to another Project' })
    }
    if (value.cause.agentRunId !== value.owner.agentRunId
      || value.cause.workSessionId !== value.owner.workSessionId) {
      context.addIssue({ code: 'custom', message: 'Agent-owned Intervention cause is inconsistent' })
    }
    if (value.owner.workSessionId !== value.returnAddress.workSessionId) {
      context.addIssue({ code: 'custom', message: 'Intervention Work Session return address is inconsistent' })
    }
    if (value.owner.agentRunId !== value.returnAddress.agentRunId) {
      context.addIssue({ code: 'custom', message: 'Intervention Agent Run return address is inconsistent' })
    }
    if (!('answer' in value) || value.answer === undefined) return
    const { answer } = value
    if (answer.payload.intent.interventionId !== value.id
      || answer.payload.actor.principalId !== value.targetPrincipalId
      || (value.state === 'answered'
        ? answer.payload.intent.expectedInterventionRevision + 1 !== value.revision
        : answer.payload.intent.expectedInterventionRevision + 2 !== value.revision)) {
      context.addIssue({ code: 'custom', message: 'Intervention answer does not address this request revision' })
    }
    if (answer.receiptId !== answer.payload.intent.intentId.replace(/^intent-/u, 'receipt-')) {
      context.addIssue({ code: 'custom', message: 'Intervention answer receipt disagrees with its Intent' })
    }
    if (canonicalDigest('saki/answer-intervention/v1', answer.payload) !== answer.payloadDigest) {
      context.addIssue({ code: 'custom', message: 'Intervention answer payload digest is stale' })
    }
    if (answer.payload.intent.answer.text.length > value.requiredAnswer.maxLength) {
      context.addIssue({ code: 'custom', message: 'Intervention answer exceeds its request-owned bound' })
    }
    if (answer.acceptedAt < value.openedAt || answer.acceptedAt > value.updatedAt) {
      context.addIssue({ code: 'custom', message: 'Intervention answer timestamp is not monotonic' })
    }
    if (value.state === 'reconciliation-required'
      && value.reconciliationRequiredAt < answer.acceptedAt) {
      context.addIssue({ code: 'custom', message: 'Intervention reconciliation timestamp is not monotonic' })
    }
    if (value.state === 'resolved'
      && (value.resolvedAt < answer.acceptedAt || value.resolvedAt > value.updatedAt)) {
      context.addIssue({ code: 'custom', message: 'Intervention resolution timestamp is not monotonic' })
    }
  })

/** Parsed durable Intervention Request. */
export type InterventionRequestRecord = z.infer<typeof interventionRequestRecordSchema>

const executionDispatchClaimSchema = z.object({
  id: dispatchClaimId,
  executorHostId: hostId,
  fencingToken: positiveRevision,
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict().refine(value => value.expiresAt > value.issuedAt, 'Dispatch claim expiry must follow issuance')

const executionDispatchRecordSharedShape = {
  id: sakiExecutionDispatchIdSchema,
  schemaVersion: z.literal(1),
  revision,
  intentId: controlIntentId,
  agentRunId: sakiAgentRunIdSchema,
  workSessionId: sakiWorkSessionIdSchema,
  hostId,
  bindingId: resourceBindingId,
  payloadDigest: digest,
  state: z.enum(['pending', 'claimed', 'accepted', 'canceled', 'reconciliation-required']),
  latestFencingToken: revision,
  claim: executionDispatchClaimSchema.optional(),
  acceptedFencingToken: positiveRevision.optional(),
  preparation: hostOperationPreparationSchema.optional(),
  operationSnapshot: hostOperationSnapshotSchema.optional(),
  terminalReason: z.enum(['authority-revoked', 'effect-unknown', 'evidence-conflict', 'protocol']).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
} as const

const executionDispatchRecordObjectSchema = z.object({
  ...executionDispatchRecordSharedShape,
  hostRequest: startAgentRunHostOperationRequestSchema,
}).strict()

function refineExecutionDispatch(
  value: z.infer<typeof executionDispatchRecordObjectSchema>,
  context: z.RefinementCtx,
): void {
  if (value.hostRequest.source.dispatchId !== value.id
    || value.hostRequest.run.agentRunId !== value.agentRunId
    || value.hostRequest.run.workSessionId !== value.workSessionId
    || value.hostRequest.expected.binding.id !== value.bindingId
    || value.hostRequest.source.payloadDigest !== value.payloadDigest) {
    context.addIssue({ code: 'custom', message: 'Execution Dispatch disagrees with its immutable Host request' })
  }
  if ((value.state === 'claimed') !== (value.claim !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Execution Dispatch claim disagrees with state' })
  }
  if (value.claim !== undefined && value.claim.fencingToken !== value.latestFencingToken) {
    context.addIssue({ code: 'custom', message: 'Execution Dispatch claim has a stale fencing token' })
  }
  if (value.state === 'accepted'
    && (value.acceptedFencingToken === undefined || value.preparation === undefined)) {
    context.addIssue({ code: 'custom', message: 'accepted Execution Dispatch lacks admission evidence' })
  }
  if (value.acceptedFencingToken !== undefined
    && (value.preparation === undefined || value.acceptedFencingToken !== value.latestFencingToken)) {
    context.addIssue({ code: 'custom', message: 'Execution Dispatch accepted fencing lacks matching preparation' })
  }
  if (value.preparation !== undefined
    && (value.preparation.operation.type !== 'start-agent-run'
      || value.preparation.operation.hostId !== value.hostId)) {
    context.addIssue({ code: 'custom', message: 'Execution Dispatch preparation disagrees with its target Host' })
  }
  if (value.operationSnapshot !== undefined
    && (value.operationSnapshot.operation.type !== 'start-agent-run'
      || value.operationSnapshot.operation.hostId !== value.hostId
      || value.operationSnapshot.source.kind !== 'execution-dispatch'
      || value.operationSnapshot.source.dispatchId !== value.id
      || value.operationSnapshot.source.payloadDigest !== value.payloadDigest
      || value.operationSnapshot.bindingId !== value.bindingId
      || value.operationSnapshot.bindingRevision !== value.hostRequest.expected.binding.revision)) {
    context.addIssue({ code: 'custom', message: 'Execution Dispatch Host snapshot disagrees with its immutable request' })
  }
  if (value.preparation !== undefined && value.operationSnapshot !== undefined
    && (value.preparation.operation.id !== value.operationSnapshot.operation.id
      || !isDeepStrictEqual(value.preparation.requestFingerprint, value.operationSnapshot.requestFingerprint))) {
    context.addIssue({ code: 'custom', message: 'Execution Dispatch preparation disagrees with Host snapshot' })
  }
  const terminal = value.state === 'canceled' || value.state === 'reconciliation-required'
  if (terminal !== (value.terminalReason !== undefined)
    || (value.state === 'canceled' && value.terminalReason !== 'authority-revoked')
    || (value.state === 'reconciliation-required' && value.terminalReason === 'authority-revoked')) {
    context.addIssue({ code: 'custom', message: 'Execution Dispatch terminal reason disagrees with state' })
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'Execution Dispatch timestamps are not monotonic' })
  }
}

/** Exact durable Execution Dispatch retained for v7 migration input. */
export const executionDispatchV1RecordSchema = z.object({
  ...executionDispatchRecordSharedShape,
  hostRequest: startAgentRunHostOperationRequestV2Schema,
}).strict().superRefine(refineExecutionDispatch)

/** Parsed exact Execution Dispatch retained by `saki_control_plane@7`. */
export type ExecutionDispatchV1Record = z.infer<typeof executionDispatchV1RecordSchema>

/** Durable one-Host delivery of one preallocated or resumed Agent Run. */
export const executionDispatchRecordSchema = executionDispatchRecordObjectSchema.superRefine(refineExecutionDispatch)

/** Parsed durable Execution Dispatch. */
export type ExecutionDispatchRecord = z.infer<typeof executionDispatchRecordSchema>

const bindingWriteAdmissionBase = {
  id: resourceBindingId,
  schemaVersion: z.literal(1),
  revision,
  updatedAt: timestamp,
} as const

const manualWriteAdmissionBase = {
  ...bindingWriteAdmissionBase,
  state: z.literal('manual-host-operation'),
  bindingRevision: revision,
  source: z.object({
    kind: z.literal('control-intent'),
    intentId: controlIntentId,
    intentRevision: revision,
    payloadDigest: digest,
  }).strict(),
  action: z.enum(['project-changes:stage', 'project-changes:unstage', 'project-commit:create']),
  reservedAt: timestamp,
} as const

const agentRunWriteAdmissionBase = {
  ...bindingWriteAdmissionBase,
  state: z.literal('agent-run'),
  bindingRevision: revision,
  originIntentId: controlIntentId,
  agentRunId: sakiAgentRunIdSchema,
  payloadDigest: digest,
  reservedAt: timestamp,
} as const

const historicalBindingWriteAdmissionVariants = [
  z.object({ ...bindingWriteAdmissionBase, state: z.literal('available') }).strict(),
  z.object({
    ...manualWriteAdmissionBase,
    phase: z.literal('reserved'),
  }).strict(),
  z.object({
    ...manualWriteAdmissionBase,
    phase: z.literal('accepted'),
    preparation: hostOperationPreparationSchema,
    acceptedAt: timestamp,
  }).strict(),
] as const

function refineHistoricalBindingWriteAdmission(
  value: z.infer<(typeof historicalBindingWriteAdmissionVariants)[number]>,
  context: z.RefinementCtx,
): void {
  if (value.state === 'manual-host-operation'
    && (value.updatedAt < value.reservedAt
      || (value.phase === 'accepted'
        && (value.acceptedAt < value.reservedAt || value.acceptedAt > value.updatedAt)))) {
    context.addIssue({ code: 'custom', message: 'write admission timestamps are not monotonic' })
  }
  if (value.state === 'manual-host-operation' && value.phase === 'accepted'
    && value.preparation.operation.type !== (value.action === 'project-commit:create'
      ? 'commit' : value.action === 'project-changes:stage' ? 'stage-files' : 'unstage-files')) {
    context.addIssue({ code: 'custom', message: 'write admission action disagrees with Host preparation' })
  }
}

/** Exact historical v6 Binding write-admission vocabulary. */
export const bindingWriteAdmissionV1RecordSchema = z.union(historicalBindingWriteAdmissionVariants)
  .superRefine(refineHistoricalBindingWriteAdmission)

/** Single local write owner for one Resource Binding; unknown variants fail closed. */
export const bindingWriteAdmissionRecordSchema = z.union([
  ...historicalBindingWriteAdmissionVariants,
  z.object({
    ...agentRunWriteAdmissionBase,
    phase: z.literal('reserved'),
  }).strict(),
  z.object({
    ...agentRunWriteAdmissionBase,
    phase: z.literal('accepted'),
    acceptedAt: timestamp,
  }).strict(),
]).superRefine((value, context) => {
  if (value.state !== 'agent-run') refineHistoricalBindingWriteAdmission(value, context)
  if (value.state === 'agent-run'
    && (value.updatedAt < value.reservedAt
      || (value.phase === 'accepted'
        && (value.acceptedAt < value.reservedAt || value.acceptedAt > value.updatedAt)))) {
    context.addIssue({ code: 'custom', message: 'Agent Run admission timestamps are not monotonic' })
  }
})

/** Parsed single-writer admission row. */
export type BindingWriteAdmissionRecord = z.infer<typeof bindingWriteAdmissionRecordSchema>

/** Exact Saki control-plane domain declaration. */
export const sakiControlPlaneDomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 8,
  tables: {
    control_state: domainTable<typeof CONTROL_STATE_KEY, ControlStateRecord>(controlStateRecordSchema),
    installations: domainTable<SakiInstallationId, InstallationRecord>(installationRecordSchema),
    hosts: domainTable<SakiHostId, HostRecord>(hostRecordSchema),
    principals: domainTable<SakiPrincipalId, PrincipalRecord>(principalRecordSchema),
    grants: domainTable<SakiGrantId, GrantRecord>(grantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, InstallationAccessRecord>(installationAccessRecordSchema),
    development_project_registry: domainTable<
      typeof DEVELOPMENT_PROJECT_REGISTRY_KEY,
      DevelopmentProjectRegistryRecord
    >(developmentProjectRegistryRecordSchema),
    registration_intents: domainTable<SakiControlIntentId, RegistrationIntentRecord>(registrationIntentRecordSchema),
    github_project_sync: domainTable<SakiDevelopmentProjectId, GitHubProjectSyncRecord>(githubProjectSyncRecordSchema),
    github_sync_configuration_intents: domainTable<
      SakiControlIntentId,
      GitHubSynchronizationConfigurationIntentRecord
    >(githubSynchronizationConfigurationIntentRecordSchema),
    git_operation_intents: domainTable<SakiControlIntentId, GitOperationIntentRecord>(gitOperationIntentRecordSchema),
    binding_write_admissions: domainTable<
      SakiResourceBindingId,
      BindingWriteAdmissionRecord
    >(bindingWriteAdmissionRecordSchema),
    github_work_item_intents: domainTable<SakiControlIntentId, GitHubWorkItemIntentRecord>(
      githubWorkItemIntentRecordSchema,
    ),
    github_work_item_recovery: domainTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord>(
      githubWorkItemRecoveryRecordSchema,
    ),
    agent_operation_intents: domainTable<SakiControlIntentId, AgentOperationIntentRecord>(
      agentOperationIntentRecordSchema,
    ),
    work_assignments: domainTable<SakiWorkAssignmentId, WorkAssignmentRecord>(workAssignmentRecordSchema),
    work_sessions: domainTable<SakiWorkSessionId, WorkSessionRecord>(workSessionRecordSchema),
    agent_runs: domainTable<SakiAgentRunId, AgentRunRecord>(agentRunRecordSchema),
    execution_dispatches: domainTable<SakiExecutionDispatchId, ExecutionDispatchRecord>(
      executionDispatchRecordSchema,
    ),
    intervention_requests: domainTable<SakiInterventionRequestId, InterventionRequestRecord>(
      interventionRequestRecordSchema,
    ),
  },
})
