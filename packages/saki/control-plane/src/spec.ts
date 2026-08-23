/** Durable Saki provisioning, entity, and Installation Access schemas. @module @breakfastdapaidang/saki-control-plane/src/spec */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { workspaceIdSchema } from '@deepseek-ai/dsh-workspace'
import {
  canonicalDigest,
  inheritedChangeBaselineIdentityMaterial,
  inheritedChangeBaselineSchema,
  isAbsoluteHostPath,
  MAX_TRUSTED_PATH_CHARS,
  projectInspectionWorkspaceIndependentMaterial,
  projectSelectionInspectionSchema,
} from '@breakfastdapaidang/saki-execution'
import type {
  SakiBootstrapChallengeId,
  SakiBrowserSessionId,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationGenerationId,
  SakiInstallationId,
  SakiPrincipalId,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiIntentReceiptId,
  SakiResourceBindingId,
} from './types.ts'

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CHILD_ORDINAL_PATTERN = '(?:0|[1-9][0-9]*)'
const brandedId = <T extends string>(prefix: string) => z.string()
  .regex(new RegExp(`^${prefix}-${UUID_PATTERN}$`))
  .transform(value => value as T)
const accessChildId = <T extends string>(kind: 'challenge' | 'session') => z.string()
  .regex(new RegExp(`^access-${UUID_PATTERN}:${kind}:${CHILD_ORDINAL_PATTERN}$`))
  .transform(value => value as T)
const installationId = brandedId<SakiInstallationId>('installation')
const installationGenerationId = brandedId<SakiInstallationGenerationId>('installation-generation')
const hostId = brandedId<SakiHostId>('host')
const principalId = brandedId<SakiPrincipalId>('principal')
const grantId = brandedId<SakiGrantId>('grant')
const installationAccessId = brandedId<SakiInstallationAccessId>('access')
const bootstrapChallengeId = accessChildId<SakiBootstrapChallengeId>('challenge')
const browserSessionId = accessChildId<SakiBrowserSessionId>('session')
const developmentProjectId = brandedId<SakiDevelopmentProjectId>('project')
const resourceBindingId = brandedId<SakiResourceBindingId>('binding')
const controlIntentId = brandedId<SakiControlIntentId>('intent')
const intentReceiptId = brandedId<SakiIntentReceiptId>('receipt')
const revision = z.number().int().nonnegative()
const ordinal = z.number().int().nonnegative()
const timestamp = z.number().int().nonnegative()
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const projectTitle = z.string().min(1).max(200).refine(value => value.trim().length > 0)
const trustedPath = z.string().min(1).max(MAX_TRUSTED_PATH_CHARS).refine(isAbsoluteHostPath)

/** Stable key of the one provisioning owner record. */
export const CONTROL_STATE_KEY = 'control-state' as const
/** Stable key of the singleton Development Project Registry aggregate. */
export const DEVELOPMENT_PROJECT_REGISTRY_KEY = 'development-project-registry' as const

/** Provisioning owner that records child identities before any child write. */
export const controlStateRecordSchema = z.object({
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

/** Parsed durable control-state record. */
export type ControlStateRecord = z.infer<typeof controlStateRecordSchema>

/** Independently revisioned Saki Installation entity. */
export const installationRecordSchema = z.object({
  id: installationId,
  revision,
  state: z.enum(['active', 'retired']),
  currentInstallationGenerationId: installationGenerationId,
  currentHostId: hostId,
}).strict()

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

/** Independently revisioned Host Operator Grant entity. */
export const grantRecordSchema = z.object({
  id: grantId,
  revision,
  installationId,
  principalId,
  state: z.enum(['active', 'revoked']),
  actions: z.array(z.enum([
    'inspect-project-selection',
    'project-index:read',
    'development-workspace:read',
    'development-project:register',
  ])),
  scope: z.object({
    kind: z.literal('installation'),
    installationId,
  }).strict(),
}).strict()

/** Parsed durable Grant entity. */
export type GrantRecord = z.infer<typeof grantRecordSchema>

/** One digest-only Bootstrap Challenge entry. */
export const bootstrapChallengeRecordSchema = z.object({
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

/** Parsed durable Bootstrap Challenge entry. */
export type BootstrapChallengeRecord = z.infer<typeof bootstrapChallengeRecordSchema>

/** One digest-only Browser Session entry. */
export const browserSessionRecordSchema = z.object({
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

/** Single versioned Installation Access aggregate owner record. */
export const installationAccessRecordSchema = z.object({
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
  challenges: z.array(bootstrapChallengeRecordSchema),
  sessions: z.array(browserSessionRecordSchema),
}).strict()

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
  confirmedFingerprint: z.object({ version: z.literal(1), digest }).strict(),
  confirmedBaseline: inheritedChangeBaselineSchema,
}).strict()

/** Server-derived authority evidence retained in the immutable Intent digest. */
export const registrationActorSchema = z.object({
  installationId,
  installationGenerationId,
  hostId,
  principalId,
  principalRevision: revision,
  grantId,
  grantRevision: revision,
}).strict()

/** Parsed server-derived registration authority evidence. */
export type RegistrationActor = z.infer<typeof registrationActorSchema>

/** Persisted recoverable registration Intent. */
export const registrationIntentRecordSchema = z.object({
  id: controlIntentId,
  schemaVersion: z.literal(1),
  revision,
  receiptId: intentReceiptId,
  payloadDigest: digest,
  payload: z.object({
    intent: registerDevelopmentProjectIntentSchema,
    actor: registrationActorSchema,
  }).strict(),
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
}).strict().superRefine((value, context) => {
  const terminal = value.phase === 'conflict'
    || value.phase === 'failure'
    || value.phase === 'reconciliation-required'
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'Intent update predates creation', path: ['updatedAt'] })
  }
  if (terminal !== (value.terminalReason !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Intent terminal reason disagrees with phase', path: ['terminalReason'] })
  }
  if (value.id !== value.payload.intent.intentId) {
    context.addIssue({ code: 'custom', message: 'Intent id disagrees with immutable payload', path: ['id'] })
  }
  if (value.receiptId !== value.id.replace(/^intent-/u, 'receipt-')) {
    context.addIssue({ code: 'custom', message: 'receipt id disagrees with Intent id', path: ['receiptId'] })
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
})

/** Parsed durable registration Intent. */
export type RegistrationIntentRecord = z.infer<typeof registrationIntentRecordSchema>

/** Exact Saki control-plane domain declaration. */
export const sakiControlPlaneDomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 2,
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
  },
})
