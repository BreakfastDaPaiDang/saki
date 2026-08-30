/** Durable Saki provisioning, entity, and Installation Access schemas. @module @breakfastdapaidang/saki-control-plane/src/spec */

import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { workspaceIdSchema } from '@deepseek-ai/dsh-workspace'
import {
  githubAccountIdSchema,
  githubAppIdSchema,
  githubFailureSchema,
  githubInstallationIdSchema,
  githubIssueIdSchema,
  githubProjectBoardFingerprintSchema,
  githubProjectFieldIdSchema,
  githubProjectIdSchema,
  githubProjectItemIdSchema,
  githubProjectOptionIdSchema,
  githubRepositoryDatabaseIdSchema,
  githubRepositoryIdSchema,
} from '@breakfastdapaidang/saki-github'
import {
  hostOperationPreparationSchema,
  hostOperationRequestSchema,
  hostOperationSnapshotSchema,
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
  selectedProjectGitChangeSchema,
} from '@breakfastdapaidang/saki-execution'
import {
  SAKI_BOARD_WORK_ITEM_LIMIT,
  SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
  SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
} from './constants.ts'
import {
  sakiBootstrapChallengeIdSchema as bootstrapChallengeId,
  sakiBoardRemoteFingerprintSchema as boardRemoteFingerprint,
  sakiBoardWorkItemIdSchema as boardWorkItemId,
  sakiBrowserSessionIdSchema as browserSessionId,
  sakiControlIntentIdSchema as controlIntentId,
  sakiDevelopmentProjectIdSchema as developmentProjectId,
  sakiGrantIdSchema as grantId,
  sakiGitHubScanAttemptIdSchema as githubScanAttemptId,
  sakiHostIdSchema as hostId,
  sakiInstallationAccessIdSchema as installationAccessId,
  sakiInstallationGenerationIdSchema as installationGenerationId,
  sakiInstallationIdSchema as installationId,
  sakiIntentReceiptIdSchema as intentReceiptId,
  sakiPrincipalIdSchema as principalId,
  sakiResourceBindingIdSchema as resourceBindingId,
  sakiStorageGenerationIdSchema as storageGenerationId,
} from './ids.ts'
import type {
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationId,
  SakiPrincipalId,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiResourceBindingId,
  SakiGitHubScanFailure,
  CreateCommitIntent,
  GitMutationExpectation,
  StageFilesIntent,
  UnstageFilesIntent,
} from './types.ts'

const revision = z.number().int().nonnegative()
const positiveRevision = z.number().int().positive()
const ordinal = z.number().int().nonnegative()
const timestamp = z.number().int().nonnegative()
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const projectTitle = z.string().min(1).max(200).refine(value => value.trim().length > 0)
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

/** Current Host Operator actions, including structured Project change operations. */
export const HOST_OPERATOR_ACTIONS = [
  ...V4_HOST_OPERATOR_ACTIONS,
  'project-changes:read',
  'project-diff:read',
  'project-changes:stage',
  'project-changes:unstage',
  'project-commit:create',
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

/** One titled Development Project child record. */
export const developmentProjectRecordSchema = z.object({
  id: developmentProjectId,
  revision,
  projectTitle,
  resourceBindingId,
  state: z.literal('active'),
  createdAt: timestamp,
}).strict()

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

/** Singleton Development Project Registry aggregate. */
export const developmentProjectRegistryRecordSchema = z.object({
  id: z.literal(DEVELOPMENT_PROJECT_REGISTRY_KEY),
  schemaVersion: z.literal(1),
  revision,
  projects: z.array(developmentProjectRecordSchema),
  resourceBindings: z.array(resourceBindingRecordSchema),
  canonicalWorktreeIndex: z.array(bindingPathIndexSchema),
  gitDirectoryIndex: z.array(bindingPathIndexSchema),
  intentMappings: z.array(registryIntentMappingSchema),
}).strict()

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
  hostRequest: hostOperationRequestSchema.optional(),
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
    && (value.operationSnapshot.source.intentId !== value.id
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

/** Single local write owner for one Resource Binding; unknown variants fail closed. */
export const bindingWriteAdmissionRecordSchema = z.union([
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
]).superRefine((value, context) => {
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
})

/** Parsed single-writer admission row. */
export type BindingWriteAdmissionRecord = z.infer<typeof bindingWriteAdmissionRecordSchema>

/** Exact Saki control-plane domain declaration. */
export const sakiControlPlaneDomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 5,
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
  },
})
