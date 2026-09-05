/** Historical schemas and pure Saki control-plane migration. @module @breakfastdapaidang/saki-control-plane/src/migration */

import { z } from 'zod'
import type { DomainMigrationSnapshot } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, defineDomainMigrations, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  canonicalDigest,
  computeProjectInspectionFingerprint,
  projectSelectionProjectionSchema,
} from '@breakfastdapaidang/saki-execution'
import { recoverBootstrapCompletion } from './bootstrap-completion.ts'
import {
  v4CanonicalDigest,
  v4ExactBytesDigest,
} from './migration-v4-canonical.ts'
import {
  v4GitHubConfigurationIntentRecordSchema,
  v4GitHubProjectSyncRecordSchema,
} from './migration-v4-github.ts'
import { v4Source } from './migration-v4-source.ts'
import { sakiAgentProfileIdSchema, sakiStorageGenerationIdSchema } from './ids.ts'
import { sakiControlPlaneDomainSpec } from './domain-spec.ts'
import {
  CONTROL_STATE_KEY,
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
  agentOperationIntentRecordSchema,
  agentRunRecordSchema,
  agentRunV1RecordSchema,
  bindingWriteAdmissionV1RecordSchema,
  bindingWriteAdmissionV2RecordSchema,
  controlStateRecordSchema,
  developmentProjectRegistryRecordSchema,
  executionDispatchRecordSchema,
  executionDispatchV1RecordSchema,
  developmentProjectRegistryV1RecordSchema,
  gitOperationIntentRecordSchema,
  githubProjectSyncRecordSchema,
  githubSynchronizationConfigurationIntentRecordSchema,
  githubWorkItemIntentRecordSchema,
  githubWorkItemRecoveryRecordSchema,
  HOST_OPERATOR_ACTIONS,
  historicalGrantRecordSchema,
  historicalRegistrationActorSchema,
  historicalControlStateRecordSchema,
  historicalInstallationAccessRecordSchema,
  historicalInstallationRecordSchema,
  hostRecordSchema,
  installationAccessRecordSchema,
  installationRecordSchema,
  interventionRequestRecordSchema,
  principalRecordSchema,
  registrationIntentRecordSchema,
  V8_HOST_OPERATOR_ACTIONS,
  V7_HOST_OPERATOR_ACTIONS,
  V5_HOST_OPERATOR_ACTIONS,
  V6_HOST_OPERATOR_ACTIONS,
  v7GrantRecordSchema,
  v8GrantRecordSchema,
  v5GrantRecordSchema,
  v6GrantRecordSchema,
  workAssignmentRecordSchema,
  workAssignmentV1RecordSchema,
  workSessionRecordSchema,
} from './spec.ts'
import type {
  ControlStateRecord,
  AgentOperationIntentRecord,
  AgentRunRecord,
  BindingWriteAdmissionV2Record,
  DevelopmentProjectRegistryRecord,
  DevelopmentProjectRegistryV1Record,
  GitOperationIntentRecord,
  GitHubProjectSyncRecord,
  GitHubSynchronizationConfigurationIntentRecord,
  GitHubWorkItemIntentRecord,
  GitHubWorkItemRecoveryRecord,
  ExecutionDispatchRecord,
  GrantRecord,
  HostRecord,
  InstallationAccessRecord,
  InstallationRecord,
  InterventionRequestRecord,
  PrincipalRecord,
  RegistrationIntentRecord,
  WorkAssignmentRecord,
  WorkSessionRecord,
} from './spec.ts'
import type {
  SakiAgentProfileId,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationGenerationId,
  SakiInstallationId,
  SakiInterventionRequestId,
  SakiPrincipalId,
  SakiResourceBindingId,
  SakiStorageGenerationId,
  SakiWorkAssignmentId,
  SakiWorkItemRecoveryId,
  SakiAgentRunId,
  SakiExecutionDispatchId,
  SakiWorkSessionId,
} from './types.ts'

const {
  V4_CONTROL_STATE_KEY,
  V4_DEVELOPMENT_PROJECT_REGISTRY_KEY,
  V4_HOST_OPERATOR_ACTIONS,
  V4_MAX_DISPLAY_LOCATION_CHARS: MAX_DISPLAY_LOCATION_CHARS,
  V4_MAX_GIT_REF_CHARS: MAX_GIT_REF_CHARS,
  V4_MAX_INVENTORY_ENTRIES: MAX_INVENTORY_ENTRIES,
  V4_MAX_REMOTE_COORDINATE_CHARS: MAX_REMOTE_COORDINATE_CHARS,
  V4_MAX_SAFE_REMOTES: MAX_SAFE_REMOTES,
  V4_MAX_TRUSTED_PATH_CHARS: MAX_TRUSTED_PATH_CHARS,
  v4CompareSafeGitRemoteObservations: compareSafeGitRemoteObservations,
  v4ControlIntentIdSchema: sakiControlIntentIdSchema,
  v4ControlStateRecordSchema,
  v4DeriveGitHubRepositoryCandidates: deriveGitHubRepositoryCandidates,
  v4DevelopmentProjectIdSchema: sakiDevelopmentProjectIdSchema,
  v4DigestSchema,
  v4GrantRecordSchema,
  v4HostIdSchema: sakiHostIdSchema,
  v4HostRecordSchema,
  v4InheritedChangeBaselineIdentityMaterial: inheritedChangeBaselineIdentityMaterial,
  v4InheritedChangeBaselineSchema: inheritedChangeBaselineSchema,
  v4InstallationAccessRecordSchema,
  v4InstallationRecordSchema,
  v4IntentReceiptIdSchema: sakiIntentReceiptIdSchema,
  v4IsAbsoluteHostPath: isAbsoluteHostPath,
  v4IsSafeDisplayLocation: isSafeDisplayLocation,
  v4IsSafeGitBranchName: isSafeGitBranchName,
  v4IsSafeGitRef: isSafeGitRef,
  v4PrincipalRecordSchema,
  v4RegistrationActorSchema: registrationActorSchema,
  v4ResourceBindingIdSchema: sakiResourceBindingIdSchema,
  v4SafeGitRemoteObservationKey: safeGitRemoteObservationKey,
  v4SafeGitRemoteObservationSchema: safeGitRemoteObservationSchema,
  v4TrustedProjectSelectionObservationSchema: trustedProjectSelectionObservationSchema,
  v4WorkspaceIdSchema: workspaceIdSchema,
} = v4Source

type HistoricalControlStateRecord = z.infer<typeof historicalControlStateRecordSchema>
type HistoricalInstallationRecord = z.infer<typeof historicalInstallationRecordSchema>
type HistoricalInstallationAccessRecord = z.infer<typeof historicalInstallationAccessRecordSchema>
type HistoricalRegistrationIntentRecord = z.infer<typeof v2RegistrationIntentRecordSchema>
type HistoricalGrantRecord = z.infer<typeof historicalGrantRecordSchema>
type V4ControlStateRecord = z.infer<typeof v4ControlStateRecordSchema>
type V4InstallationRecord = z.infer<typeof v4InstallationRecordSchema>
type V4HostRecord = z.infer<typeof v4HostRecordSchema>
type V4PrincipalRecord = z.infer<typeof v4PrincipalRecordSchema>
type V4GrantRecord = z.infer<typeof v4GrantRecordSchema>
type V4InstallationAccessRecord = z.infer<typeof v4InstallationAccessRecordSchema>

/* Historical registration schemas are frozen migration inputs and cannot import mutable current-schema definitions. */
/* jscpd:ignore-start */
const digest = v4DigestSchema
const revision = z.number().int().nonnegative()
const timestamp = z.number().int().nonnegative()
const projectTitle = z.string().min(1).max(200).refine(value => value.trim().length > 0)
const trustedPath = z.string().min(1).max(MAX_TRUSTED_PATH_CHARS).refine(isAbsoluteHostPath)
const v4InspectionFingerprintSchema = z.object({ version: z.literal(1), digest }).strict()
const v4ProjectSelectionProjectionSchema = z.object({
  observationVersion: z.literal(1),
  hostId: sakiHostIdSchema,
  displayLocation: z.string().min(1).max(MAX_DISPLAY_LOCATION_CHARS).refine(isSafeDisplayLocation),
  objectFormat: z.enum(['sha1', 'sha256']),
  head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u).refine(value => !/^0+$/u.test(value)),
  branch: z.string().min(1).max(MAX_GIT_REF_CHARS).refine(isSafeGitBranchName).optional(),
  detached: z.boolean(),
  upstream: z.string().min(1).max(MAX_GIT_REF_CHARS).refine(isSafeGitRef).optional(),
  locked: z.boolean(),
  inheritedChangeEntryCount: z.number().int().nonnegative().max(MAX_INVENTORY_ENTRIES),
  conversionAmbiguous: z.boolean(),
  remotes: z.array(safeGitRemoteObservationSchema).max(MAX_SAFE_REMOTES),
  githubRepositoryCandidates: z.array(z.string().min(1).max(MAX_REMOTE_COORDINATE_CHARS)).max(MAX_SAFE_REMOTES).optional(),
  workspaceId: workspaceIdSchema.optional(),
  automaticMutationEligible: z.boolean(),
  blockingReasons: z.array(z.enum(['dirty', 'baseline-unavailable', 'conversion-ambiguous', 'locked'])).max(4),
  fingerprint: v4InspectionFingerprintSchema,
  baseline: inheritedChangeBaselineSchema,
}).strict().superRefine((value, context) => {
  if (value.detached === (value.branch !== undefined)) {
    context.addIssue({ code: 'custom', message: 'branch and detached state disagree', path: ['branch'] })
  }
  if (value.upstream !== undefined && value.detached) {
    context.addIssue({ code: 'custom', message: 'upstream requires an attached branch', path: ['upstream'] })
  }
  const expectedWidth = value.objectFormat === 'sha1' ? 40 : 64
  if (value.head.length !== expectedWidth) {
    context.addIssue({ code: 'custom', message: 'HEAD does not match object format', path: ['head'] })
  }
  if (value.inheritedChangeEntryCount !== value.baseline.observed.entries) {
    context.addIssue({ code: 'custom', message: 'inherited-change count disagrees with baseline observations' })
  }
  if (value.baseline.kind === 'complete') {
    for (const [index, entry] of value.baseline.entries.entries()) {
      const slots = entry.statusKind === 'tracked'
        ? [entry.head, entry.index]
        : entry.statusKind === 'unmerged' ? [entry.head, ...entry.stages] : []
      const objects = [
        ...slots.flatMap(slot => slot.kind === 'object' ? [slot.objectId] : []),
        ...(entry.worktree.kind === 'submodule' ? [entry.worktree.objectId] : []),
      ]
      if (objects.some(object => object.length !== expectedWidth)) {
        context.addIssue({ code: 'custom', message: 'baseline object does not match object format',
          path: ['baseline', 'entries', index] })
      }
    }
  }
  const expectedReasons = [
    ...(value.inheritedChangeEntryCount > 0 ? ['dirty' as const] : []),
    ...(value.baseline.kind === 'unavailable' ? ['baseline-unavailable' as const] : []),
    ...(value.conversionAmbiguous ? ['conversion-ambiguous' as const] : []),
    ...(value.locked ? ['locked' as const] : []),
  ]
  if (value.automaticMutationEligible !== (expectedReasons.length === 0)
      || expectedReasons.length !== value.blockingReasons.length
      || expectedReasons.some((reason, index) => value.blockingReasons[index] !== reason)) {
    context.addIssue({ code: 'custom', message: 'automatic mutation eligibility disagrees with blocking evidence' })
  }
  const remoteKeys = value.remotes.map(safeGitRemoteObservationKey)
  if (new Set(remoteKeys).size !== remoteKeys.length
      || value.remotes.some((remote, index) => {
        const previous = value.remotes.at(index - 1)
        return index > 0 && previous !== undefined && compareSafeGitRemoteObservations(previous, remote) > 0
      })) context.addIssue({ code: 'custom', message: 'remote observations are not unique and canonical' })
  const expectedCandidates = deriveGitHubRepositoryCandidates(value.remotes)
  const candidates = value.githubRepositoryCandidates
  if (expectedCandidates.length === 0 ? candidates !== undefined : candidates === undefined
      || candidates.length !== expectedCandidates.length
      || candidates.some((candidate, index) => candidate !== expectedCandidates[index])) {
    context.addIssue({ code: 'custom', message: 'GitHub repository candidates disagree with remote observations' })
  }
})
function v4InspectionFingerprintMaterial(
  projection: z.infer<typeof v4ProjectSelectionProjectionSchema>,
  trusted: z.infer<typeof trustedProjectSelectionObservationSchema>,
) {
  return {
    observationVersion: 1 as const,
    hostId: projection.hostId,
    displayLocation: projection.displayLocation,
    worktreePathDigest: v4ExactBytesDigest('saki/worktree-path/v1', new TextEncoder().encode(trusted.canonicalWorktreePath)),
    gitDirectoryDigest: v4ExactBytesDigest('saki/git-directory/v1', new TextEncoder().encode(trusted.canonicalGitDirectory)),
    commonDirectoryDigest: v4ExactBytesDigest('saki/common-git-directory/v1', new TextEncoder().encode(trusted.canonicalCommonGitDirectory)),
    gitDirectoryIdentity: trusted.gitDirectoryIdentity,
    commonGitDirectoryIdentity: trusted.commonGitDirectoryIdentity,
    objectFormat: projection.objectFormat,
    head: projection.head,
    ...(projection.branch === undefined ? {} : { branch: `refs/heads/${projection.branch}` }),
    detached: projection.detached,
    locked: projection.locked,
    inheritedChangeEntryCount: projection.inheritedChangeEntryCount,
    conversionAmbiguous: projection.conversionAmbiguous,
    comparison: trusted.comparison,
    workspace: projection.workspaceId === undefined
      ? { kind: 'absent' as const }
      : { kind: 'present' as const, workspaceId: projection.workspaceId },
    ...(projection.upstream === undefined ? {} : { upstream: projection.upstream }),
    remotes: projection.remotes,
    ...(projection.githubRepositoryCandidates === undefined
      ? {} : { githubRepositoryCandidates: projection.githubRepositoryCandidates }),
    baseline: inheritedChangeBaselineIdentityMaterial(projection.baseline),
  }
}

const v4ProjectSelectionInspectionSchema = z.object({
  projection: v4ProjectSelectionProjectionSchema,
  trusted: trustedProjectSelectionObservationSchema,
}).strict().superRefine((value, context) => {
  const material = v4InspectionFingerprintMaterial(value.projection, value.trusted)
  if (v4CanonicalDigest('saki/project-inspection/v1', material) !== value.projection.fingerprint.digest) {
    context.addIssue({ code: 'custom', message: 'inspection fingerprint disagrees with retained evidence' })
  }
})

const v4ResourceBindingRecordSchema = z.object({
  id: sakiResourceBindingIdSchema,
  revision,
  projectId: sakiDevelopmentProjectIdSchema,
  hostId: sakiHostIdSchema,
  workspaceId: workspaceIdSchema,
  health: z.enum(['active', 'missing', 'repair-required']),
  registrationInspection: v4ProjectSelectionInspectionSchema,
  currentInspection: v4ProjectSelectionInspectionSchema.optional(),
  inheritedChangeBaseline: inheritedChangeBaselineSchema,
  createdAt: timestamp,
  observedAt: timestamp,
}).strict().superRefine((value, context) => {
  if (value.observedAt < value.createdAt) context.addIssue({ code: 'custom', message: 'binding observation predates creation' })
  if (value.registrationInspection.projection.hostId !== value.hostId
    || (value.currentInspection !== undefined && value.currentInspection.projection.hostId !== value.hostId)) {
    context.addIssue({ code: 'custom', message: 'binding inspection belongs to another Host' })
  }
  if (v4CanonicalDigest('saki/inherited-baseline/identity/v1', inheritedChangeBaselineIdentityMaterial(
    value.registrationInspection.projection.baseline,
  )) !== v4CanonicalDigest('saki/inherited-baseline/identity/v1', inheritedChangeBaselineIdentityMaterial(
    value.inheritedChangeBaseline,
  ))) context.addIssue({ code: 'custom', message: 'binding inherited baseline differs from registration evidence' })
  if (value.health === 'active' && value.currentInspection === undefined) {
    context.addIssue({ code: 'custom', message: 'active binding has no current inspection' })
  }
  if (value.health === 'missing' && value.currentInspection !== undefined) {
    context.addIssue({ code: 'custom', message: 'missing binding retains a current inspection' })
  }
  const current = value.currentInspection
  if (current !== undefined) {
    if (current.projection.workspaceId !== value.workspaceId) {
      context.addIssue({ code: 'custom', message: 'binding current inspection disagrees with Workspace identity' })
    }
    const registration = value.registrationInspection.trusted
    const observed = current.trusted
    if (observed.canonicalWorktreePath !== registration.canonicalWorktreePath
      || observed.canonicalGitDirectory !== registration.canonicalGitDirectory
      || observed.canonicalCommonGitDirectory !== registration.canonicalCommonGitDirectory
      || observed.gitDirectoryIdentity.digest !== registration.gitDirectoryIdentity.digest
      || observed.commonGitDirectoryIdentity.digest !== registration.commonGitDirectoryIdentity.digest) {
      context.addIssue({ code: 'custom', message: 'binding current inspection changed resource identity' })
    }
  }
})
const v4DevelopmentProjectRegistryRecordSchema = z.object({
  id: z.literal(V4_DEVELOPMENT_PROJECT_REGISTRY_KEY),
  schemaVersion: z.literal(1),
  revision,
  projects: z.array(z.object({
    id: sakiDevelopmentProjectIdSchema,
    revision,
    projectTitle,
    resourceBindingId: sakiResourceBindingIdSchema,
    state: z.literal('active'),
    createdAt: timestamp,
  }).strict()),
  resourceBindings: z.array(v4ResourceBindingRecordSchema),
  canonicalWorktreeIndex: z.array(z.object({
    hostId: sakiHostIdSchema,
    path: trustedPath,
    resourceBindingId: sakiResourceBindingIdSchema,
  }).strict()),
  gitDirectoryIndex: z.array(z.object({
    hostId: sakiHostIdSchema,
    path: trustedPath,
    resourceBindingId: sakiResourceBindingIdSchema,
  }).strict()),
  intentMappings: z.array(z.object({
    intentId: sakiControlIntentIdSchema,
    projectId: sakiDevelopmentProjectIdSchema,
    resourceBindingId: sakiResourceBindingIdSchema,
    registryRevision: revision,
  }).strict()),
}).strict().superRefine((value, context) => {
  const unique = (values: readonly string[]) => new Set(values).size === values.length
  const collections = [
    value.projects.map(project => project.id),
    value.resourceBindings.map(binding => binding.id),
    value.resourceBindings.map(binding => binding.workspaceId),
    value.projects.map(project => project.resourceBindingId),
    value.resourceBindings.map(binding => binding.projectId),
    value.canonicalWorktreeIndex.map(entry => `${entry.hostId}\0${entry.path}`),
    value.gitDirectoryIndex.map(entry => `${entry.hostId}\0${entry.path}`),
    value.intentMappings.map(mapping => mapping.intentId),
    value.intentMappings.map(mapping => mapping.projectId),
    value.intentMappings.map(mapping => mapping.resourceBindingId),
    value.intentMappings.map(mapping => String(mapping.registryRevision)),
  ]
  if (collections.some(collection => !unique(collection))) {
    context.addIssue({ code: 'custom', message: 'Project Registry repeats an owned identity' })
  }
  if (value.projects.length !== value.resourceBindings.length
    || value.projects.length !== value.canonicalWorktreeIndex.length
    || value.projects.length !== value.gitDirectoryIndex.length
    || value.projects.length !== value.intentMappings.length) {
    context.addIssue({ code: 'custom', message: 'Project Registry child and index cardinalities disagree' })
  }
  for (const project of value.projects) {
    const binding = value.resourceBindings.find(candidate => candidate.id === project.resourceBindingId)
    if (binding?.projectId !== project.id) context.addIssue({ code: 'custom', message: 'Project has an inconsistent Resource Binding' })
  }
  for (const binding of value.resourceBindings) {
    const worktree = value.canonicalWorktreeIndex.filter(entry => entry.resourceBindingId === binding.id
      && entry.hostId === binding.hostId
      && entry.path === binding.registrationInspection.trusted.canonicalWorktreePath)
    const git = value.gitDirectoryIndex.filter(entry => entry.resourceBindingId === binding.id
      && entry.hostId === binding.hostId
      && entry.path === binding.registrationInspection.trusted.canonicalGitDirectory)
    if (worktree.length !== 1 || git.length !== 1) {
      context.addIssue({ code: 'custom', message: 'Resource Binding has inconsistent path indices' })
    }
  }
  for (const mapping of value.intentMappings) {
    const project = value.projects.find(candidate => candidate.id === mapping.projectId)
    const binding = value.resourceBindings.find(candidate => candidate.id === mapping.resourceBindingId)
    if (project === undefined || binding === undefined || project.resourceBindingId !== binding.id
      || mapping.registryRevision > value.revision) {
      context.addIssue({ code: 'custom', message: 'registration Intent maps to inconsistent children' })
    }
  }
})
const v4RegisterDevelopmentProjectIntentSchema = z.object({
  type: z.literal('register-development-project'),
  intentId: sakiControlIntentIdSchema,
  projectTitle,
  hostId: sakiHostIdSchema,
  directoryLocator: z.string().min(1).max(32_768),
  expectedRegistryRevision: revision,
  confirmedFingerprint: v4InspectionFingerprintSchema,
  confirmedBaseline: inheritedChangeBaselineSchema,
}).strict()
function refineV4RegistrationIntent(
  value: {
    readonly id: string
    readonly receiptId: string
    readonly payloadDigest: string
    readonly payload: {
      readonly actor: { readonly hostId: string }
      readonly intent: {
        readonly intentId: string
        readonly hostId: string
        readonly expectedRegistryRevision: number
        readonly confirmedFingerprint: { readonly digest: string }
        readonly confirmedBaseline: z.infer<typeof inheritedChangeBaselineSchema>
      }
    }
    readonly inspection: z.infer<typeof v4ProjectSelectionInspectionSchema>
    readonly workspaceInspection?: z.infer<typeof v4ProjectSelectionInspectionSchema> | undefined
    readonly phase: 'prepared' | 'workspace-dispatching' | 'workspace-observed' | 'registry-committed' | 'confirmed' | 'conflict' | 'failure' | 'reconciliation-required'
    readonly workspaceId?: string | undefined
    readonly projectId?: string | undefined
    readonly resourceBindingId?: string | undefined
    readonly registryRevision?: number | undefined
    readonly terminalReason?: 'expected-revision' | 'duplicate-binding' | 'authority' | 'workspace' | 'observation' | undefined
    readonly createdAt: number
    readonly updatedAt: number
  },
  context: z.RefinementCtx,
): void {
  if (value.id !== value.payload.intent.intentId
    || value.receiptId !== value.id.replace(/^intent-/u, 'receipt-')) {
    context.addIssue({ code: 'custom', message: 'Intent identity disagrees with immutable payload' })
  }
  if (value.payload.intent.confirmedFingerprint.digest !== value.inspection.projection.fingerprint.digest) {
    context.addIssue({ code: 'custom', message: 'Intent confirmation disagrees with retained inspection' })
  }
  if (value.payload.actor.hostId !== value.payload.intent.hostId
    || value.payload.intent.hostId !== value.inspection.projection.hostId
    || v4CanonicalDigest('saki/inherited-baseline/identity/v1', inheritedChangeBaselineIdentityMaterial(
      value.payload.intent.confirmedBaseline,
    )) !== v4CanonicalDigest('saki/inherited-baseline/identity/v1', inheritedChangeBaselineIdentityMaterial(
      value.inspection.projection.baseline,
    ))) context.addIssue({ code: 'custom', message: 'Intent confirmation disagrees with retained inspection' })
  if (value.updatedAt < value.createdAt) context.addIssue({ code: 'custom', message: 'Intent update predates creation' })
  const terminal = value.phase === 'conflict' || value.phase === 'failure' || value.phase === 'reconciliation-required'
  if (terminal !== (value.terminalReason !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Intent terminal reason disagrees with phase' })
  }
  const hasWorkspace = value.workspaceId !== undefined
  if (value.workspaceInspection !== undefined && value.workspaceId === undefined) {
    context.addIssue({ code: 'custom', message: 'Workspace inspection has no retained identity' })
  }
  if (value.workspaceInspection !== undefined && value.workspaceId !== undefined) {
    if (value.workspaceInspection.projection.hostId !== value.payload.intent.hostId) {
      context.addIssue({ code: 'custom', message: 'Workspace observation disagrees with retained identity' })
    }
    const requiresCasEvidence = value.phase === 'workspace-observed' || value.phase === 'registry-committed'
      || value.phase === 'confirmed' || value.phase === 'conflict'
    if (requiresCasEvidence) {
      if (value.workspaceInspection.projection.workspaceId !== value.workspaceId
        || (value.inspection.projection.workspaceId !== undefined
          && value.inspection.projection.workspaceId !== value.workspaceId)) {
        context.addIssue({ code: 'custom', message: 'Workspace observation disagrees with retained identity' })
      }
      const left = v4InspectionFingerprintMaterial(value.workspaceInspection.projection, value.workspaceInspection.trusted)
      const right = v4InspectionFingerprintMaterial(value.inspection.projection, value.inspection.trusted)
      const { workspace: _leftWorkspace, ...leftIndependent } = left
      const { workspace: _rightWorkspace, ...rightIndependent } = right
      if (v4CanonicalDigest('saki/project-inspection/workspace-independent/v1', leftIndependent)
        !== v4CanonicalDigest('saki/project-inspection/workspace-independent/v1', rightIndependent)) {
        context.addIssue({ code: 'custom', message: 'Workspace observation changed repository evidence' })
      }
    }
  }
  const committedCount = [value.projectId, value.resourceBindingId, value.registryRevision]
    .filter(field => field !== undefined).length
  if (committedCount !== 0 && committedCount !== 3) {
    context.addIssue({ code: 'custom', message: 'registry commit fields must appear together' })
  }
  if ((value.phase === 'prepared' || value.phase === 'workspace-dispatching') && (hasWorkspace || committedCount !== 0)) {
    context.addIssue({ code: 'custom', message: 'early Intent phase contains later-phase evidence' })
  }
  if (value.phase === 'workspace-observed' && (!hasWorkspace || committedCount !== 0)) {
    context.addIssue({ code: 'custom', message: 'workspace-observed phase evidence is incomplete' })
  }
  if ((value.phase === 'registry-committed' || value.phase === 'confirmed')
    && (!hasWorkspace || value.workspaceInspection === undefined || committedCount !== 3)) {
    context.addIssue({ code: 'custom', message: 'committed Intent phase evidence is incomplete' })
  }
  if (terminal && committedCount !== 0) context.addIssue({ code: 'custom', message: 'terminal Intent contains registry commit evidence' })
  if (value.registryRevision !== undefined
    && value.registryRevision !== value.payload.intent.expectedRegistryRevision + 1) {
    context.addIssue({ code: 'custom', message: 'Intent commit revision disagrees with expected revision' })
  }
  if (value.phase === 'conflict' && value.terminalReason !== 'expected-revision'
    && value.terminalReason !== 'duplicate-binding') context.addIssue({ code: 'custom', message: 'conflict phase has an invalid terminal reason' })
  if (value.phase === 'conflict' && (!hasWorkspace || value.workspaceInspection === undefined)) {
    context.addIssue({ code: 'custom', message: 'conflict phase has no Workspace evidence' })
  }
  if (value.phase === 'failure' && value.terminalReason !== 'authority') {
    context.addIssue({ code: 'custom', message: 'failure phase has an invalid terminal reason' })
  }
  if (value.phase === 'failure' && hasWorkspace) context.addIssue({ code: 'custom', message: 'authority failure contains Workspace evidence' })
  if (value.phase === 'reconciliation-required' && value.terminalReason !== 'workspace'
    && value.terminalReason !== 'observation') context.addIssue({ code: 'custom', message: 'reconciliation phase has an invalid terminal reason' })
  if (v4CanonicalDigest('saki/register-development-project/v1', value.payload) !== value.payloadDigest) {
    context.addIssue({ code: 'custom', message: 'Intent payload digest is stale', path: ['payloadDigest'] })
  }
}

const v4RegistrationIntentRecordSchema = z.object({
  id: sakiControlIntentIdSchema,
  schemaVersion: z.literal(2),
  revision,
  receiptId: sakiIntentReceiptIdSchema,
  payloadDigest: digest,
  payload: z.object({
    intent: v4RegisterDevelopmentProjectIntentSchema,
    actor: registrationActorSchema,
  }).strict(),
  inspection: v4ProjectSelectionInspectionSchema,
  workspaceInspection: v4ProjectSelectionInspectionSchema.optional(),
  phase: z.enum(['prepared', 'workspace-dispatching', 'workspace-observed', 'registry-committed', 'confirmed',
    'conflict', 'failure', 'reconciliation-required']),
  workspaceId: workspaceIdSchema.optional(),
  projectId: sakiDevelopmentProjectIdSchema.optional(),
  resourceBindingId: sakiResourceBindingIdSchema.optional(),
  registryRevision: revision.optional(),
  terminalReason: z.enum(['expected-revision', 'duplicate-binding', 'authority', 'workspace', 'observation']).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine(refineV4RegistrationIntent)
const v2RegistrationIntentRecordSchema = z.object({
  id: sakiControlIntentIdSchema,
  schemaVersion: z.literal(1),
  revision,
  receiptId: sakiIntentReceiptIdSchema,
  payloadDigest: digest,
  payload: z.object({
    intent: v4RegisterDevelopmentProjectIntentSchema,
    actor: historicalRegistrationActorSchema,
  }).strict(),
  inspection: v4ProjectSelectionInspectionSchema,
  workspaceInspection: v4ProjectSelectionInspectionSchema.optional(),
  phase: z.enum(['prepared', 'workspace-dispatching', 'workspace-observed', 'registry-committed', 'confirmed',
    'conflict', 'failure', 'reconciliation-required']),
  workspaceId: workspaceIdSchema.optional(),
  projectId: sakiDevelopmentProjectIdSchema.optional(),
  resourceBindingId: sakiResourceBindingIdSchema.optional(),
  registryRevision: revision.optional(),
  terminalReason: z.enum(['expected-revision', 'duplicate-binding', 'authority', 'workspace', 'observation']).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine(refineV4RegistrationIntent)
type V4DevelopmentProjectRegistryRecord = z.infer<typeof v4DevelopmentProjectRegistryRecordSchema>
type V4RegistrationIntentRecord = z.infer<typeof v4RegistrationIntentRecordSchema>
/* jscpd:ignore-end */

/** Exact B03 control-plane schema accepted as the sole v2 migration source. */
export const sakiControlPlaneV2DomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 2,
  tables: {
    control_state: domainTable<typeof CONTROL_STATE_KEY, HistoricalControlStateRecord>(
      historicalControlStateRecordSchema,
    ),
    installations: domainTable<SakiInstallationId, HistoricalInstallationRecord>(historicalInstallationRecordSchema),
    hosts: domainTable<SakiHostId, HostRecord>(hostRecordSchema),
    principals: domainTable<SakiPrincipalId, PrincipalRecord>(principalRecordSchema),
    grants: domainTable<SakiGrantId, HistoricalGrantRecord>(historicalGrantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, HistoricalInstallationAccessRecord>(
      historicalInstallationAccessRecordSchema,
    ),
    development_project_registry: domainTable<
      typeof DEVELOPMENT_PROJECT_REGISTRY_KEY,
      V4DevelopmentProjectRegistryRecord
    >(v4DevelopmentProjectRegistryRecordSchema),
    registration_intents: domainTable<SakiControlIntentId, HistoricalRegistrationIntentRecord>(
      v2RegistrationIntentRecordSchema,
    ),
  },
})

/** Exact post-B18 v3 control-plane schema retained as the adjacent B05 migration source. */
export const sakiControlPlaneV3DomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 3,
  tables: {
    control_state: domainTable<typeof CONTROL_STATE_KEY, ControlStateRecord>(
      controlStateRecordSchema,
    ),
    installations: domainTable<SakiInstallationId, InstallationRecord>(installationRecordSchema),
    hosts: domainTable<SakiHostId, HostRecord>(hostRecordSchema),
    principals: domainTable<SakiPrincipalId, PrincipalRecord>(principalRecordSchema),
    grants: domainTable<SakiGrantId, HistoricalGrantRecord>(historicalGrantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, InstallationAccessRecord>(
      installationAccessRecordSchema,
    ),
    development_project_registry: domainTable<
      typeof DEVELOPMENT_PROJECT_REGISTRY_KEY,
      V4DevelopmentProjectRegistryRecord
    >(v4DevelopmentProjectRegistryRecordSchema),
    registration_intents: domainTable<SakiControlIntentId, V4RegistrationIntentRecord>(
      v4RegistrationIntentRecordSchema,
    ),
  },
})

/** Exact v4 control-plane schema retained as the adjacent v5 migration source. */
export const sakiControlPlaneV4DomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 4,
  tables: {
    control_state: domainTable<typeof V4_CONTROL_STATE_KEY, V4ControlStateRecord>(v4ControlStateRecordSchema),
    installations: domainTable<SakiInstallationId, V4InstallationRecord>(v4InstallationRecordSchema),
    hosts: domainTable<SakiHostId, V4HostRecord>(v4HostRecordSchema),
    principals: domainTable<SakiPrincipalId, V4PrincipalRecord>(v4PrincipalRecordSchema),
    grants: domainTable<SakiGrantId, V4GrantRecord>(v4GrantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, V4InstallationAccessRecord>(
      v4InstallationAccessRecordSchema,
    ),
    development_project_registry: domainTable<
      typeof V4_DEVELOPMENT_PROJECT_REGISTRY_KEY,
      V4DevelopmentProjectRegistryRecord
    >(v4DevelopmentProjectRegistryRecordSchema),
    registration_intents: domainTable<SakiControlIntentId, V4RegistrationIntentRecord>(v4RegistrationIntentRecordSchema),
    github_project_sync: domainTable<SakiDevelopmentProjectId, z.infer<typeof v4GitHubProjectSyncRecordSchema>>(
      v4GitHubProjectSyncRecordSchema,
    ),
    github_sync_configuration_intents: domainTable<
      SakiControlIntentId,
      z.infer<typeof v4GitHubConfigurationIntentRecordSchema>
    >(v4GitHubConfigurationIntentRecordSchema),
  },
})

/* jscpd:ignore-start -- Explicit v5/v6 table inventories freeze each adjacent migration source independently. */
/** Exact v5 control-plane schema retained as the adjacent v6 migration source. */
export const sakiControlPlaneV5DomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 5,
  tables: {
    control_state: domainTable<typeof CONTROL_STATE_KEY, ControlStateRecord>(controlStateRecordSchema),
    installations: domainTable<SakiInstallationId, InstallationRecord>(installationRecordSchema),
    hosts: domainTable<SakiHostId, HostRecord>(hostRecordSchema),
    principals: domainTable<SakiPrincipalId, PrincipalRecord>(principalRecordSchema),
    grants: domainTable<SakiGrantId, z.infer<typeof v5GrantRecordSchema>>(v5GrantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, InstallationAccessRecord>(
      installationAccessRecordSchema,
    ),
    development_project_registry: domainTable<
      typeof DEVELOPMENT_PROJECT_REGISTRY_KEY,
      DevelopmentProjectRegistryV1Record
    >(developmentProjectRegistryV1RecordSchema),
    registration_intents: domainTable<SakiControlIntentId, RegistrationIntentRecord>(registrationIntentRecordSchema),
    github_project_sync: domainTable<SakiDevelopmentProjectId, z.infer<typeof v4GitHubProjectSyncRecordSchema>>(
      v4GitHubProjectSyncRecordSchema,
    ),
    github_sync_configuration_intents: domainTable<
      SakiControlIntentId,
      z.infer<typeof v4GitHubConfigurationIntentRecordSchema>
    >(v4GitHubConfigurationIntentRecordSchema),
    git_operation_intents: domainTable<SakiControlIntentId, GitOperationIntentRecord>(gitOperationIntentRecordSchema),
    binding_write_admissions: domainTable<
      SakiResourceBindingId,
      z.infer<typeof bindingWriteAdmissionV1RecordSchema>
    >(
      bindingWriteAdmissionV1RecordSchema,
    ),
  },
})

/** Exact v6 control-plane schema retained as the adjacent v7 migration source. */
export const sakiControlPlaneV6DomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 6,
  tables: {
    control_state: domainTable<typeof CONTROL_STATE_KEY, ControlStateRecord>(controlStateRecordSchema),
    installations: domainTable<SakiInstallationId, InstallationRecord>(installationRecordSchema),
    hosts: domainTable<SakiHostId, HostRecord>(hostRecordSchema),
    principals: domainTable<SakiPrincipalId, PrincipalRecord>(principalRecordSchema),
    grants: domainTable<SakiGrantId, z.infer<typeof v6GrantRecordSchema>>(v6GrantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, InstallationAccessRecord>(
      installationAccessRecordSchema,
    ),
    development_project_registry: domainTable<
      typeof DEVELOPMENT_PROJECT_REGISTRY_KEY,
      DevelopmentProjectRegistryV1Record
    >(developmentProjectRegistryV1RecordSchema),
    registration_intents: domainTable<SakiControlIntentId, RegistrationIntentRecord>(registrationIntentRecordSchema),
    github_project_sync: domainTable<SakiDevelopmentProjectId, GitHubProjectSyncRecord>(
      githubProjectSyncRecordSchema,
    ),
    github_sync_configuration_intents: domainTable<
      SakiControlIntentId,
      GitHubSynchronizationConfigurationIntentRecord
    >(githubSynchronizationConfigurationIntentRecordSchema),
    git_operation_intents: domainTable<SakiControlIntentId, GitOperationIntentRecord>(gitOperationIntentRecordSchema),
    binding_write_admissions: domainTable<
      SakiResourceBindingId,
      z.infer<typeof bindingWriteAdmissionV1RecordSchema>
    >(
      bindingWriteAdmissionV1RecordSchema,
    ),
    github_work_item_intents: domainTable<SakiControlIntentId, GitHubWorkItemIntentRecord>(
      githubWorkItemIntentRecordSchema,
    ),
    github_work_item_recovery: domainTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord>(
      githubWorkItemRecoveryRecordSchema,
    ),
  },
})

/** Exact v7 control-plane schema retained as the adjacent v8 migration source. */
export const sakiControlPlaneV7DomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 7,
  tables: {
    control_state: domainTable<typeof CONTROL_STATE_KEY, ControlStateRecord>(controlStateRecordSchema),
    installations: domainTable<SakiInstallationId, InstallationRecord>(installationRecordSchema),
    hosts: domainTable<SakiHostId, HostRecord>(hostRecordSchema),
    principals: domainTable<SakiPrincipalId, PrincipalRecord>(principalRecordSchema),
    grants: domainTable<SakiGrantId, z.infer<typeof v7GrantRecordSchema>>(v7GrantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, InstallationAccessRecord>(
      installationAccessRecordSchema,
    ),
    development_project_registry: domainTable<
      typeof DEVELOPMENT_PROJECT_REGISTRY_KEY,
      DevelopmentProjectRegistryRecord
    >(developmentProjectRegistryRecordSchema),
    registration_intents: domainTable<SakiControlIntentId, RegistrationIntentRecord>(registrationIntentRecordSchema),
    github_project_sync: domainTable<SakiDevelopmentProjectId, GitHubProjectSyncRecord>(
      githubProjectSyncRecordSchema,
    ),
    github_sync_configuration_intents: domainTable<
      SakiControlIntentId,
      GitHubSynchronizationConfigurationIntentRecord
    >(githubSynchronizationConfigurationIntentRecordSchema),
    git_operation_intents: domainTable<SakiControlIntentId, GitOperationIntentRecord>(gitOperationIntentRecordSchema),
    binding_write_admissions: domainTable<SakiResourceBindingId, BindingWriteAdmissionV2Record>(
      bindingWriteAdmissionV2RecordSchema,
    ),
    github_work_item_intents: domainTable<SakiControlIntentId, GitHubWorkItemIntentRecord>(
      githubWorkItemIntentRecordSchema,
    ),
    github_work_item_recovery: domainTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord>(
      githubWorkItemRecoveryRecordSchema,
    ),
    agent_operation_intents: domainTable<SakiControlIntentId, AgentOperationIntentRecord>(
      agentOperationIntentRecordSchema,
    ),
    work_assignments: domainTable<SakiWorkAssignmentId, z.infer<typeof workAssignmentV1RecordSchema>>(
      workAssignmentV1RecordSchema,
    ),
    work_sessions: domainTable<SakiWorkSessionId, WorkSessionRecord>(workSessionRecordSchema),
    agent_runs: domainTable<SakiAgentRunId, z.infer<typeof agentRunV1RecordSchema>>(agentRunV1RecordSchema),
    execution_dispatches: domainTable<SakiExecutionDispatchId, z.infer<typeof executionDispatchV1RecordSchema>>(
      executionDispatchV1RecordSchema,
    ),
  },
})

/** Exact v8 control-plane schema retained as the adjacent v9 migration source. */
export const sakiControlPlaneV8DomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 8,
  tables: {
    control_state: domainTable<typeof CONTROL_STATE_KEY, ControlStateRecord>(controlStateRecordSchema),
    installations: domainTable<SakiInstallationId, InstallationRecord>(installationRecordSchema),
    hosts: domainTable<SakiHostId, HostRecord>(hostRecordSchema),
    principals: domainTable<SakiPrincipalId, PrincipalRecord>(principalRecordSchema),
    grants: domainTable<SakiGrantId, z.infer<typeof v8GrantRecordSchema>>(v8GrantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, InstallationAccessRecord>(
      installationAccessRecordSchema,
    ),
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
    binding_write_admissions: domainTable<SakiResourceBindingId, BindingWriteAdmissionV2Record>(
      bindingWriteAdmissionV2RecordSchema,
    ),
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
/* jscpd:ignore-end */

function sourceTable<T>(snapshot: DomainMigrationSnapshot, name: string): Readonly<Record<string, T>> {
  return snapshot.tables[name] as Readonly<Record<string, T>>
}

function mapTable<S, T>(records: Readonly<Record<string, S>>, transform: (value: S) => T): Record<string, T> {
  return Object.fromEntries(Object.entries(records).map(([key, value]) => [key, transform(value)]))
}

/**
 * Retain historical generation attribution under the v3 storage-generation identity vocabulary.
 * @param value - schema-validated historical Installation State Generation identity.
 * @returns the corresponding retained storage-generation identity.
 */
export function migratedStorageGenerationId(
  value: SakiInstallationGenerationId,
): SakiStorageGenerationId {
  const uuid = value.slice('installation-generation-'.length)
  return sakiStorageGenerationIdSchema.parse(`storage-generation-${uuid}`)
}

function migrateControlState(value: HistoricalControlStateRecord): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...value }
  delete migrated['initialInstallationGenerationId']
  migrated['schemaVersion'] = 2
  return migrated
}

function migrateInstallation(value: HistoricalInstallationRecord): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...value }
  delete migrated['currentInstallationGenerationId']
  return migrated
}

function migratedBootstrapCompletion(
  value: HistoricalInstallationAccessRecord,
): HistoricalInstallationAccessRecord['bootstrapCompletion'] {
  if (value.bootstrapCompletion !== undefined) return value.bootstrapCompletion
  return recoverBootstrapCompletion(value, 'B03 Installation Access')
}

function migrateInstallationAccess(value: HistoricalInstallationAccessRecord): Record<string, unknown> {
  const bootstrapCompletion = migratedBootstrapCompletion(value)
  return {
    ...value,
    schemaVersion: 2,
    ...(bootstrapCompletion === undefined ? {} : { bootstrapCompletion }),
    challenges: value.challenges.map((challenge) => {
      const migrated: Record<string, unknown> = { ...challenge }
      delete migrated['installationGenerationId']
      migrated['storageGenerationId'] = migratedStorageGenerationId(challenge.installationGenerationId)
      return migrated
    }),
    sessions: value.sessions.map((session) => {
      const migrated: Record<string, unknown> = { ...session }
      delete migrated['installationGenerationId']
      migrated['storageGenerationId'] = migratedStorageGenerationId(session.installationGenerationId)
      return migrated
    }),
  }
}

function migrateRegistrationIntent(value: HistoricalRegistrationIntentRecord): Record<string, unknown> {
  const actor: Record<string, unknown> = { ...value.payload.actor }
  delete actor['installationGenerationId']
  actor['storageGenerationId'] = migratedStorageGenerationId(value.payload.actor.installationGenerationId)
  const payload = { ...value.payload, actor }
  return {
    ...value,
    schemaVersion: 2,
    payload,
    payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
  }
}

function migrateGrantsToV4(snapshot: DomainMigrationSnapshot): Record<string, GrantRecord> {
  const control = sourceTable<ControlStateRecord>(snapshot, 'control_state')[CONTROL_STATE_KEY]
  return Object.fromEntries(Object.entries(sourceTable<HistoricalGrantRecord>(snapshot, 'grants')).map(([key, value]) => {
    if (key !== control?.hostOperatorGrantId) return [key, value]
    return [key, {
      ...value,
      revision: value.revision + 1,
      actions: [...V4_HOST_OPERATOR_ACTIONS],
    }]
  }))
}

function migrateGrantsToV5(
  snapshot: DomainMigrationSnapshot,
): Record<string, z.infer<typeof v5GrantRecordSchema>> {
  const control = sourceTable<V4ControlStateRecord>(snapshot, 'control_state')[V4_CONTROL_STATE_KEY]
  return Object.fromEntries(Object.entries(sourceTable<V4GrantRecord>(snapshot, 'grants')).map(([key, value]) => {
    if (key !== control?.hostOperatorGrantId) return [key, value]
    return [key, { ...value, revision: value.revision + 1, actions: [...V5_HOST_OPERATOR_ACTIONS] }]
  }))
}

function migrateGrantsToV6(snapshot: DomainMigrationSnapshot): Record<string, z.infer<typeof v6GrantRecordSchema>> {
  const control = sourceTable<ControlStateRecord>(snapshot, 'control_state')[CONTROL_STATE_KEY]
  return Object.fromEntries(Object.entries(
    sourceTable<z.infer<typeof v5GrantRecordSchema>>(snapshot, 'grants'),
  ).map(([key, value]) => {
    if (key !== control?.hostOperatorGrantId) return [key, value]
    return [key, { ...value, revision: value.revision + 1, actions: [...V6_HOST_OPERATOR_ACTIONS] }]
  }))
}

function migrateGrantsToV7(
  snapshot: DomainMigrationSnapshot,
): Record<string, z.infer<typeof v7GrantRecordSchema>> {
  const control = sourceTable<ControlStateRecord>(snapshot, 'control_state')[CONTROL_STATE_KEY]
  return Object.fromEntries(Object.entries(
    sourceTable<z.infer<typeof v6GrantRecordSchema>>(snapshot, 'grants'),
  ).map(([key, value]) => {
    if (key !== control?.hostOperatorGrantId) return [key, value]
    return [key, { ...value, revision: value.revision + 1, actions: [...V7_HOST_OPERATOR_ACTIONS] }]
  }))
}

function migrateGrantsToV8(
  snapshot: DomainMigrationSnapshot,
): Record<string, z.infer<typeof v8GrantRecordSchema>> {
  const control = sourceTable<ControlStateRecord>(snapshot, 'control_state')[CONTROL_STATE_KEY]
  return Object.fromEntries(Object.entries(
    sourceTable<z.infer<typeof v7GrantRecordSchema>>(snapshot, 'grants'),
  ).map(([key, value]) => {
    if (key !== control?.hostOperatorGrantId) return [key, value]
    return [key, { ...value, revision: value.revision + 1, actions: [...V8_HOST_OPERATOR_ACTIONS] }]
  }))
}

function migrateGrantsToV9(snapshot: DomainMigrationSnapshot): Record<string, GrantRecord> {
  const control = sourceTable<ControlStateRecord>(snapshot, 'control_state')[CONTROL_STATE_KEY]
  return Object.fromEntries(Object.entries(
    sourceTable<z.infer<typeof v8GrantRecordSchema>>(snapshot, 'grants'),
  ).map(([key, value]) => {
    if (key !== control?.hostOperatorGrantId) return [key, value]
    return [key, { ...value, revision: value.revision + 1, actions: [...HOST_OPERATOR_ACTIONS] }]
  }))
}

function migrateWorkAssignmentsToV8(snapshot: DomainMigrationSnapshot): Record<string, Record<string, unknown>> {
  const intents = sourceTable<AgentOperationIntentRecord>(snapshot, 'agent_operation_intents')
  return mapTable(
    sourceTable<z.infer<typeof workAssignmentV1RecordSchema>>(snapshot, 'work_assignments'),
    (assignment) => {
      const intent = intents[assignment.intentId]
      if (intent === undefined
        || intent.assignmentId !== assignment.id
        || intent.agentRunId !== assignment.agentRunId
        || intent.workSessionId !== assignment.primaryWorkSessionId
        || intent.projectContext.projectId !== assignment.projectId
        || intent.payload.intent.workItemId !== assignment.workItemId) {
        throw new Error(`v7 Work Assignment '${assignment.id}' lacks its exact Agent operation owner`)
      }
      return {
        ...assignment,
        schemaVersion: 2,
        ownerPrincipalId: intent.payload.actor.principalId,
      }
    },
  )
}

function migrateAgentRunsToV8(snapshot: DomainMigrationSnapshot): Record<string, Record<string, unknown>> {
  return mapTable(
    sourceTable<z.infer<typeof agentRunV1RecordSchema>>(snapshot, 'agent_runs'),
    run => ({ ...run, schemaVersion: 2 }),
  )
}

function migrateV4Inspection(value: z.infer<typeof v4ProjectSelectionInspectionSchema>) {
  const { branch, detached: _detached, fingerprint: _fingerprint, head, observationVersion: _version,
    workspaceId, githubRepositoryCandidates, upstream, ...retained }
    = value.projection
  const projection = {
    ...retained,
    observationVersion: 2 as const,
    head: {
      kind: 'commit' as const,
      objectId: head,
      ...(branch === undefined ? {} : { symbolicRef: `refs/heads/${branch}` }),
    },
    ...(upstream === undefined ? {} : { upstream }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(githubRepositoryCandidates === undefined ? {} : { githubRepositoryCandidates }),
    remotes: retained.remotes.map(remote => remote.coordinate === undefined
      ? { transport: remote.transport }
      : { transport: remote.transport, coordinate: remote.coordinate }),
  }
  return projectSelectionProjectionSchema.parse({
    ...projection,
    fingerprint: computeProjectInspectionFingerprint(projection, value.trusted),
  })
}

function migrateV4InspectionEnvelope(value: z.infer<typeof v4ProjectSelectionInspectionSchema>) {
  return { projection: migrateV4Inspection(value), trusted: value.trusted }
}

function migrateV4Registry(value: V4DevelopmentProjectRegistryRecord): DevelopmentProjectRegistryV1Record {
  return developmentProjectRegistryV1RecordSchema.parse({
    ...value,
    resourceBindings: value.resourceBindings.map(binding => ({
      ...binding,
      registrationInspection: migrateV4InspectionEnvelope(binding.registrationInspection),
      ...(binding.currentInspection === undefined
        ? {} : { currentInspection: migrateV4InspectionEnvelope(binding.currentInspection) }),
    })),
  })
}

function migratedAgentProfileId(projectId: SakiDevelopmentProjectId): SakiAgentProfileId {
  return sakiAgentProfileIdSchema.parse(`agent-profile-${projectId.slice('project-'.length)}`)
}

function migrateProjectRegistryToV7(value: DevelopmentProjectRegistryV1Record): DevelopmentProjectRegistryRecord {
  return developmentProjectRegistryRecordSchema.parse({
    ...value,
    schemaVersion: 2,
    projects: value.projects.map(project => ({
      ...project,
      defaultAgentProfileId: migratedAgentProfileId(project.id),
    })),
    agentProfiles: value.projects.map(project => ({
      id: migratedAgentProfileId(project.id),
      projectId: project.id,
      version: 1,
      agentPresetId: 'standard',
      modelRouteRequest: null,
      createdAt: project.createdAt,
    })),
  })
}

function migrateV4RegistrationIntent(value: V4RegistrationIntentRecord): RegistrationIntentRecord {
  const inspection = migrateV4InspectionEnvelope(value.inspection)
  const payload = {
    ...value.payload,
    intent: { ...value.payload.intent, confirmedFingerprint: inspection.projection.fingerprint },
  }
  return registrationIntentRecordSchema.parse({
    ...value,
    payload,
    payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
    inspection,
    ...(value.workspaceInspection === undefined
      ? {} : { workspaceInspection: migrateV4InspectionEnvelope(value.workspaceInspection) }),
  })
}

function migrateV4BindingWriteAdmissions(
  snapshot: DomainMigrationSnapshot,
): Record<string, Record<string, unknown>> {
  const registry = sourceTable<V4DevelopmentProjectRegistryRecord>(
    snapshot,
    'development_project_registry',
  )[V4_DEVELOPMENT_PROJECT_REGISTRY_KEY]
  if (registry === undefined) return {}
  return Object.fromEntries(registry.resourceBindings.map(binding => [binding.id, {
    id: binding.id,
    schemaVersion: 1,
    revision: 0,
    state: 'available',
    updatedAt: binding.observedAt,
  }]))
}

function migrateGitHubProjectSyncToV6(
  snapshot: DomainMigrationSnapshot,
): Record<string, Record<string, unknown>> {
  return mapTable(
    sourceTable<z.infer<typeof v4GitHubProjectSyncRecordSchema>>(snapshot, 'github_project_sync'),
    record => ({
      ...record,
      schemaVersion: 2,
      ...(record.confirmedBoard === undefined
        ? {}
        : {
          confirmedBoard: {
            ...record.confirmedBoard,
            items: record.confirmedBoard.items.map(item => ({
              ...item,
              latestNonTerminalStatus: item.status === 'done' || item.status === 'canceled'
                ? null
                : item.status,
            })),
          },
        }),
    }),
  )
}

/** Pure retained migration chain from exact B03 v2 media through frozen adjacent formats to current v9 records. */
export const sakiControlPlaneMigrationPlan = defineDomainMigrations({
  current: sakiControlPlaneDomainSpec,
  steps: [
    {
      from: sakiControlPlaneV2DomainSpec,
      to: sakiControlPlaneV3DomainSpec,
      migrate: snapshot => ({
        global: snapshot.global,
        tables: {
          control_state: mapTable(
            sourceTable<HistoricalControlStateRecord>(snapshot, 'control_state'),
            migrateControlState,
          ),
          installations: mapTable(
            sourceTable<HistoricalInstallationRecord>(snapshot, 'installations'),
            migrateInstallation,
          ),
          hosts: { ...sourceTable<HostRecord>(snapshot, 'hosts') },
          principals: { ...sourceTable<PrincipalRecord>(snapshot, 'principals') },
          grants: { ...sourceTable<HistoricalGrantRecord>(snapshot, 'grants') },
          installation_access: mapTable(
            sourceTable<HistoricalInstallationAccessRecord>(snapshot, 'installation_access'),
            migrateInstallationAccess,
          ),
          development_project_registry: {
            ...sourceTable<V4DevelopmentProjectRegistryRecord>(snapshot, 'development_project_registry'),
          },
          registration_intents: mapTable(
            sourceTable<HistoricalRegistrationIntentRecord>(snapshot, 'registration_intents'),
            migrateRegistrationIntent,
          ),
        },
      }),
    },
    {
      from: sakiControlPlaneV3DomainSpec,
      to: sakiControlPlaneV4DomainSpec,
      migrate: snapshot => ({
        global: snapshot.global,
        tables: {
          control_state: { ...sourceTable<ControlStateRecord>(snapshot, 'control_state') },
          installations: { ...sourceTable<InstallationRecord>(snapshot, 'installations') },
          hosts: { ...sourceTable<HostRecord>(snapshot, 'hosts') },
          principals: { ...sourceTable<PrincipalRecord>(snapshot, 'principals') },
          grants: migrateGrantsToV4(snapshot),
          installation_access: { ...sourceTable<InstallationAccessRecord>(snapshot, 'installation_access') },
          development_project_registry: {
            ...sourceTable<V4DevelopmentProjectRegistryRecord>(snapshot, 'development_project_registry'),
          },
          registration_intents: { ...sourceTable<RegistrationIntentRecord>(snapshot, 'registration_intents') },
          github_project_sync: {},
          github_sync_configuration_intents: {},
        },
      }),
    },
    {
      from: sakiControlPlaneV4DomainSpec,
      to: sakiControlPlaneV5DomainSpec,
      migrate: snapshot => ({
        global: snapshot.global,
        tables: {
          ...snapshot.tables,
          grants: migrateGrantsToV5(snapshot),
          development_project_registry: mapTable(
            sourceTable<V4DevelopmentProjectRegistryRecord>(snapshot, 'development_project_registry'),
            migrateV4Registry,
          ),
          registration_intents: mapTable(
            sourceTable<V4RegistrationIntentRecord>(snapshot, 'registration_intents'),
            migrateV4RegistrationIntent,
          ),
          git_operation_intents: {},
          binding_write_admissions: migrateV4BindingWriteAdmissions(snapshot),
        },
      }),
    },
    {
      from: sakiControlPlaneV5DomainSpec,
      to: sakiControlPlaneV6DomainSpec,
      migrate: snapshot => ({
        global: snapshot.global,
        tables: {
          ...snapshot.tables,
          grants: migrateGrantsToV6(snapshot),
          github_project_sync: migrateGitHubProjectSyncToV6(snapshot),
          github_work_item_intents: {},
          github_work_item_recovery: {},
        },
      }),
    },
    {
      from: sakiControlPlaneV6DomainSpec,
      to: sakiControlPlaneV7DomainSpec,
      migrate: snapshot => ({
        global: snapshot.global,
        tables: {
          ...snapshot.tables,
          grants: migrateGrantsToV7(snapshot),
          development_project_registry: mapTable(
            sourceTable<DevelopmentProjectRegistryV1Record>(snapshot, 'development_project_registry'),
            migrateProjectRegistryToV7,
          ),
          agent_operation_intents: {},
          work_assignments: {},
          work_sessions: {},
          agent_runs: {},
          execution_dispatches: {},
        },
      }),
    },
    {
      from: sakiControlPlaneV7DomainSpec,
      to: sakiControlPlaneV8DomainSpec,
      migrate: snapshot => ({
        global: snapshot.global,
        tables: {
          ...snapshot.tables,
          grants: migrateGrantsToV8(snapshot),
          work_assignments: migrateWorkAssignmentsToV8(snapshot),
          agent_runs: migrateAgentRunsToV8(snapshot),
          intervention_requests: {},
        },
      }),
    },
    {
      from: sakiControlPlaneV8DomainSpec,
      to: sakiControlPlaneDomainSpec,
      migrate: snapshot => ({
        global: snapshot.global,
        tables: {
          ...snapshot.tables,
          grants: migrateGrantsToV9(snapshot),
          branch_deliveries: {},
          branch_delivery_intents: {},
          milestone_deliveries: {},
          milestone_delivery_intents: {},
        },
      }),
    },
  ],
})
