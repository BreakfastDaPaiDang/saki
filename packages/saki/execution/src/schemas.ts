/** Strict durable and wire-compatible schemas for Host inspection values. @module @breakfastdapaidang/saki-execution/schemas */

import { z } from 'zod'
import type {
  ActiveHostProjectBinding,
  AppliedProjectGitChange,
  CommitHostOperationRequest,
  CommitHostOperationResult,
  CompleteInheritedChangeBaseline,
  ControlIntentHostOperationSource,
  ExecutionDispatchHostOperationSource,
  HostGitMutationPrecondition,
  HostOperationChange,
  HostOperationPreparation,
  HostOperationReference,
  HostOperationRequest,
  HostOperationRequestV2,
  HostOperationRequestFingerprint,
  HostOperationSnapshot,
  HostOperationSource,
  HostOperationStartResult,
  InheritedChangeBaseline,
  InheritedChangeBaselineEntry,
  InheritedCurrentWorktreeEvidence,
  InspectInterventionOpeningRequest,
  InterventionOpeningEvidence,
  InspectProjectRequest,
  InspectProjectResult,
  InspectProjectCommitRequest,
  InspectProjectCommitResult,
  InspectProjectSelectionResult,
  ProjectGitChange,
  ProjectGitIndexEvidence,
  ProjectGitDiffCursor,
  ProjectGitDiffPage,
  ProjectGitHead,
  ProjectGitPatchFingerprint,
  ProjectGitStatusFingerprint,
  ProjectGitStatusObservation,
  ProjectGitWorktreeFingerprint,
  ProjectGitWorktreeEvidence,
  ProjectInspectionFingerprint,
  ProjectSelectionInspection,
  ProjectSelectionProjection,
  PushBranchHostOperationRequest,
  PushBranchHostOperationResult,
  ReadProjectDiffOperationRequest,
  ReadProjectDiffRequest,
  ReadProjectDiffResult,
  SafeGitRemoteObservation,
  SakiAgentRunId,
  SakiAgentProfileId,
  SakiExecutionDispatchId,
  SakiControlIntentActorAttribution,
  SakiInterventionAnswerMessageSource,
  SakiWorkSessionId,
  SelectedProjectGitChange,
  StageFilesHostOperationRequest,
  StageFilesHostOperationResult,
  StartAgentRunHostOperationRequest,
  StartAgentRunHostOperationRequestV2,
  StartAgentRunHostOperationResult,
  StartAgentRunInputMessage,
  StartAgentRunInputMessageV2,
  StartAgentRunProfile,
  UnstageFilesHostOperationRequest,
  UnstageFilesHostOperationResult,
  WorkspaceId,
} from './types.ts'
import { canonicalDigest } from './canonical.ts'
import {
  computeProjectGitChangeFingerprint,
  computeProjectGitChangeId,
  computeProjectGitStatusFingerprint,
  computeProjectGitStatusSeedDigest,
  computeProjectInspectionFingerprint,
  computeStartAgentRunPayloadDigest,
  inheritedChangeBaselineIdentityMaterial,
  projectGitStatusSeedMaterial,
} from './fingerprint.ts'

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const UTF8 = new TextEncoder()

/**
 * Test one value against the closed nonzero Git object-id vocabulary.
 * @param value - candidate lower-case hexadecimal object id.
 * @param objectFormat - optional repository object format that fixes the required width.
 * @returns whether the value is a nonzero SHA-1 or SHA-256 Git object id of the requested format.
 */
export function isGitObjectId(value: string, objectFormat?: 'sha1' | 'sha256'): boolean {
  const expectedWidth = objectFormat === undefined ? undefined : objectFormat === 'sha1' ? 40 : 64
  return (expectedWidth === undefined ? value.length === 40 || value.length === 64 : value.length === expectedWidth)
    && /^[0-9a-f]+$/u.test(value)
    && !/^0+$/u.test(value)
}

const gitObject = z.string().refine(value => isGitObjectId(value))
const gitMode = z.enum(['000000', '100644', '100755', '120000', '160000'])
const hostId = z.string().regex(/^host-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const workspaceIdSchema = z.string().transform(value => value as WorkspaceId)
/** Strict Control Intent identity shared with the Host Operation seam. */
export const sakiControlIntentIdSchema = z.string()
  .regex(/^intent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as ControlIntentHostOperationSource['intentId'])

/** Strict Development Agent Profile identity shared with the control plane. */
export const sakiAgentProfileIdSchema = z.string()
  .regex(/^agent-profile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as SakiAgentProfileId)

/** Strict Execution Dispatch identity shared with Agent-start Host Operations. */
export const sakiExecutionDispatchIdSchema = z.string()
  .regex(/^dispatch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as SakiExecutionDispatchId)

/** Strict Agent Run identity shared with Agent-start Host Operations. */
export const sakiAgentRunIdSchema = z.string()
  .regex(/^agent-run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as SakiAgentRunId)

/** Strict Work Session identity shared with Agent-start Host Operations. */
export const sakiWorkSessionIdSchema = z.string()
  .regex(/^work-session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as SakiWorkSessionId)

/** Strict durable Intervention identity shared with answer delivery. */
export const sakiInterventionRequestIdSchema = z.string()
  .regex(/^intervention-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as SakiInterventionAnswerMessageSource['interventionId'])
const sakiInstallationIdSchema = z.string()
  .regex(/^installation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as SakiControlIntentActorAttribution['installationId'])
const sakiStorageGenerationIdSchema = z.string()
  .regex(/^storage-generation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as SakiControlIntentActorAttribution['storageGenerationId'])
const sakiPrincipalIdSchema = z.string()
  .regex(/^principal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as SakiControlIntentActorAttribution['principalId'])
const sakiGrantIdSchema = z.string()
  .regex(/^grant-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as SakiControlIntentActorAttribution['grantId'])
/** Strict durable Host Operation identity. */
export const hostOperationIdSchema = z.string()
  .regex(/^host-operation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as HostOperationReference['id'])
/** Strict Host-owned Resource Binding identity. */
export const sakiResourceBindingIdSchema = z.string()
  .regex(/^binding-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as ActiveHostProjectBinding['id'])
/** Strict observation-scoped Git change identity. */
export const projectGitChangeIdSchema = z.string().regex(/^git-change-[0-9a-f]{64}$/)
  .transform(value => value as ProjectGitChange['id'])
const nonnegative = z.number().int().nonnegative()
const positive = z.number().int().positive()

/** Maximum browser-safe display label length. */
export const MAX_DISPLAY_LOCATION_CHARS = 512
/** Maximum projected Git ref length. */
export const MAX_GIT_REF_CHARS = 4_096
/** Maximum normalized remote coordinate length. */
export const MAX_REMOTE_COORDINATE_CHARS = 4_096
/** Maximum number of safe remote observations. */
export const MAX_SAFE_REMOTES = 256
/** Maximum trusted Host path length retained durably. */
export const MAX_TRUSTED_PATH_CHARS = 32_768
/** Fixed protocol ceiling for retained baseline entries. */
export const MAX_INHERITED_BASELINE_ENTRIES = 10_000
/** Fixed protocol ceiling for complete repository inventory membership. */
export const MAX_INVENTORY_ENTRIES = 100_000
/** Fixed protocol ceiling for structured status rows. */
export const MAX_PROJECT_GIT_STATUS_CHANGES = MAX_INVENTORY_ENTRIES
/** Fixed protocol ceiling for UTF-8 path bytes across one structured status. */
export const MAX_PROJECT_GIT_STATUS_PATH_BYTES = 16 * 1024 * 1024
/** Fixed protocol ceiling for one opaque Diff cursor. */
export const MAX_PROJECT_GIT_DIFF_CURSOR_CHARS = 4_096
/** Fixed protocol ceiling for logical lines in one Diff page. */
export const MAX_PROJECT_GIT_DIFF_PAGE_LINES = 1_000
/** Fixed protocol ceiling for UTF-8 bytes in one LF-terminated Diff line. */
export const MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES = 64 * 1024
/** Fixed protocol ceiling for UTF-8 bytes returned in one Diff page. */
export const MAX_PROJECT_GIT_DIFF_PAGE_UTF8_BYTES = 256 * 1024
/** Fixed protocol ceiling for logical lines in one complete Diff. */
export const MAX_PROJECT_GIT_DIFF_TOTAL_LINES = 100_000
/** Fixed protocol ceiling for UTF-8 bytes in one complete Diff. */
export const MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES = 16 * 1024 * 1024
/** Fixed protocol ceiling for one structured mutation selection. */
export const MAX_HOST_OPERATION_SELECTED_CHANGES = MAX_PROJECT_GIT_STATUS_CHANGES
/** Fixed protocol ceiling for one persisted Commit message. */
export const MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES = 1024 * 1024
/** Fixed protocol ceiling for one complete model-visible Agent Run input. */
export const MAX_START_AGENT_RUN_INPUT_UTF8_BYTES = 256 * 1024

const symbolicHeadRef = z.string().min(1).max(MAX_GIT_REF_CHARS).refine(value =>
  value.startsWith('refs/heads/')
  && isSafeGitRef(value)
  && isSafeGitBranchName(value.slice('refs/heads/'.length)),
)

const unsafeDisplayCodePoint = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** Applied baseline capture bounds. */
export const inheritedChangeBaselineBoundsSchema = z.object({
  maxEntries: positive.max(MAX_INHERITED_BASELINE_ENTRIES),
  maxPathBytes: positive,
  maxGitOutputBytes: positive,
  maxFileBytes: positive,
  maxTotalFileBytes: positive,
  maxCaptureMs: positive,
}).strict()

/** Observed capture resource totals. */
export const inheritedChangeBaselineObservedLimitsSchema = z.object({
  entries: nonnegative.max(MAX_INVENTORY_ENTRIES),
  pathBytes: nonnegative,
  gitOutputBytes: nonnegative,
  hashedBytes: nonnegative,
  elapsedMs: nonnegative,
}).strict()

const regularWorktreeEvidenceSchema = z.object({
  kind: z.literal('regular'),
  mode: z.enum(['100644', '100755']),
  byteLength: nonnegative,
  contentDigest: digest,
}).strict()
const symlinkWorktreeEvidenceSchema = z.object({ kind: z.literal('symlink'), targetDigest: digest }).strict()
const submoduleWorktreeEvidenceSchema = z.object({ kind: z.literal('submodule'), objectId: gitObject }).strict()
const missingWorktreeEvidenceSchema = z.object({ kind: z.literal('missing') }).strict()

/** One closed current-worktree evidence variant. */
export const inheritedCurrentWorktreeEvidenceSchema: z.ZodType<InheritedCurrentWorktreeEvidence> = z.discriminatedUnion('kind', [
  regularWorktreeEvidenceSchema,
  symlinkWorktreeEvidenceSchema,
  submoduleWorktreeEvidenceSchema,
  missingWorktreeEvidenceSchema,
])

const gitObjectEvidenceSchema = z.object({
  kind: z.literal('object'),
  mode: gitMode.exclude(['000000']),
  objectId: gitObject,
}).strict()
const gitObjectSlotSchema = z.discriminatedUnion('kind', [gitObjectEvidenceSchema, missingWorktreeEvidenceSchema])

const baselineEntryBase = {
  formatVersion: z.literal(1),
  pathDigest: digest,
  digest,
} as const

const structuralBaselineEntrySchema = z.discriminatedUnion('statusKind', [
  z.object({
    ...baselineEntryBase,
    statusKind: z.literal('tracked'),
    head: gitObjectSlotSchema,
    index: gitObjectSlotSchema,
    worktree: inheritedCurrentWorktreeEvidenceSchema,
  }).strict().refine(value => value.head.kind === 'object' || value.index.kind === 'object'),
  z.object({
    ...baselineEntryBase,
    statusKind: z.literal('untracked'),
    worktree: z.discriminatedUnion('kind', [regularWorktreeEvidenceSchema, symlinkWorktreeEvidenceSchema]),
  }).strict(),
  z.object({
    ...baselineEntryBase,
    statusKind: z.literal('unmerged'),
    head: gitObjectSlotSchema,
    stages: z.tuple([gitObjectSlotSchema, gitObjectSlotSchema, gitObjectSlotSchema]),
    worktree: inheritedCurrentWorktreeEvidenceSchema,
  }).strict().refine(value => value.stages.some(stage => stage.kind === 'object')),
])

/** One exact-path-digest baseline entry. */
export const inheritedChangeBaselineEntrySchema: z.ZodType<InheritedChangeBaselineEntry> =
  structuralBaselineEntrySchema.superRefine((value, context) => {
    if (value.statusKind !== 'untracked' && value.worktree.kind === 'submodule') {
      const slots = value.statusKind === 'tracked'
        ? [value.head, value.index]
        : [value.head, ...value.stages]
      if (!slots.some(slot => slot.kind === 'object' && slot.mode === '160000')) {
        context.addIssue({ code: 'custom', message: 'submodule worktree evidence lacks a gitlink slot' })
      }
    }
    const { digest: actual, ...material } = value
    if (canonicalDigest('saki/inherited-entry/v1', material) !== actual) {
      context.addIssue({ code: 'custom', message: 'baseline entry digest disagrees with retained evidence' })
    }
  })

/** Complete baseline required as a mutation precondition. */
export const completeInheritedChangeBaselineSchema = z.object({
  kind: z.literal('complete'),
  formatVersion: z.literal(1),
  capturedAt: nonnegative,
  bounds: inheritedChangeBaselineBoundsSchema,
  observed: inheritedChangeBaselineObservedLimitsSchema,
  entries: z.array(inheritedChangeBaselineEntrySchema).max(MAX_INHERITED_BASELINE_ENTRIES),
  digest,
}).strict().superRefine((value, context) => {
  const withinBounds = value.observed.entries === value.entries.length
      && value.observed.entries <= value.bounds.maxEntries
      && value.observed.pathBytes <= value.bounds.maxPathBytes
      && value.observed.gitOutputBytes <= value.bounds.maxGitOutputBytes
      && value.observed.hashedBytes <= value.bounds.maxTotalFileBytes
      && value.observed.elapsedMs <= value.bounds.maxCaptureMs
  if (!withinBounds) context.addIssue({ code: 'custom', message: 'baseline observations exceed applied bounds' })
  const pathDigests = new Set(value.entries.map(entry => entry.pathDigest))
  if (pathDigests.size !== value.entries.length) {
    context.addIssue({ code: 'custom', message: 'baseline contains duplicate path identity' })
  }
  const regularBytes = value.entries.reduce((total, entry) => total
      + (entry.worktree.kind === 'regular' ? entry.worktree.byteLength : 0), 0)
  if (value.entries.some(entry => entry.worktree.kind === 'regular'
      && entry.worktree.byteLength > value.bounds.maxFileBytes)
      || regularBytes > value.observed.hashedBytes) {
    context.addIssue({ code: 'custom', message: 'baseline retained bytes disagree with observations' })
  }
  const objectWidths = new Set(value.entries.flatMap((entry) => {
    const slots = entry.statusKind === 'tracked'
      ? [entry.head, entry.index]
      : entry.statusKind === 'unmerged' ? [entry.head, ...entry.stages] : []
    return [
      ...slots.flatMap(slot => slot.kind === 'object' ? [slot.objectId.length] : []),
      ...(entry.worktree.kind === 'submodule' ? [entry.worktree.objectId.length] : []),
    ]
  }))
  if (objectWidths.size > 1) {
    context.addIssue({ code: 'custom', message: 'baseline contains mixed Git object formats' })
  }
  const expectedDigest = canonicalDigest('saki/inherited-baseline/v1', {
    formatVersion: value.formatVersion,
    bounds: value.bounds,
    observed: { ...value.observed, elapsedMs: 0 },
    entries: value.entries,
  })
  if (expectedDigest !== value.digest) {
    context.addIssue({ code: 'custom', message: 'baseline digest disagrees with retained evidence' })
  }
}) satisfies z.ZodType<CompleteInheritedChangeBaseline>

/** Entire complete-or-unavailable baseline result. */
export const inheritedChangeBaselineSchema: z.ZodType<InheritedChangeBaseline> = z.discriminatedUnion('kind', [
  completeInheritedChangeBaselineSchema,
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum([
      'entry-limit', 'path-limit', 'git-output-limit', 'file-limit', 'hash-limit', 'time-limit',
      'invalid-utf8', 'duplicate-path', 'unsupported-state', 'unstable-content', 'io-failure',
    ]),
    observed: inheritedChangeBaselineObservedLimitsSchema,
  }).strict(),
])

/** Versioned inspection digest. */
export const projectInspectionFingerprintSchema: z.ZodType<ProjectInspectionFingerprint> = z.object({
  version: z.literal(2),
  digest,
}).strict()

/** Attached, detached, or unborn Git HEAD without zero-object sentinels. */
export const projectGitHeadSchema: z.ZodType<ProjectGitHead> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('commit'),
    objectId: gitObject,
    symbolicRef: symbolicHeadRef.optional(),
  }).strict(),
  z.object({ kind: z.literal('unborn'), symbolicRef: symbolicHeadRef }).strict(),
]) as unknown as z.ZodType<ProjectGitHead>

function refineGitHeadObjectFormat(
  value: { readonly objectFormat: 'sha1' | 'sha256'; readonly head: ProjectGitHead },
  context: z.RefinementCtx,
): 40 | 64 {
  const expectedObjectLength = value.objectFormat === 'sha1' ? 40 : 64
  if (value.head.kind === 'commit' && value.head.objectId.length !== expectedObjectLength) {
    context.addIssue({ code: 'custom', message: 'HEAD does not match object format', path: ['head', 'objectId'] })
  }
  return expectedObjectLength
}

/** One safe, normalized remote observation. */
export const safeGitRemoteObservationSchema = z.object({
  transport: z.enum(['https', 'ssh', 'file', 'other']),
  coordinate: z.string().min(1).max(MAX_REMOTE_COORDINATE_CHARS).optional(),
}).strict().superRefine((value, context) => {
  if (value.coordinate !== undefined
    && (value.transport === 'file' || value.transport === 'other'
      || !isNormalizedRemoteCoordinate(value.coordinate))) {
    context.addIssue({ code: 'custom', message: 'remote coordinate is not normalized' })
  }
})

/** Browser-safe inspection Projection. */
// Zod optional outputs include explicit `undefined`; JSON omits that value and
// the public interface intentionally models absence only.
export const projectSelectionProjectionSchema = z.object({
  observationVersion: z.literal(2),
  hostId: hostId.transform(value => value as ProjectSelectionProjection['hostId']),
  displayLocation: z.string().min(1).max(MAX_DISPLAY_LOCATION_CHARS).refine(isSafeDisplayLocation),
  objectFormat: z.enum(['sha1', 'sha256']),
  head: projectGitHeadSchema,
  upstream: z.string().min(1).max(MAX_GIT_REF_CHARS).refine(isSafeGitRef).optional(),
  locked: z.boolean(),
  inheritedChangeEntryCount: nonnegative.max(MAX_INVENTORY_ENTRIES),
  conversionAmbiguous: z.boolean(),
  remotes: z.array(safeGitRemoteObservationSchema).max(MAX_SAFE_REMOTES),
  githubRepositoryCandidates: z.array(z.string().min(1).max(MAX_REMOTE_COORDINATE_CHARS))
    .max(MAX_SAFE_REMOTES).optional(),
  workspaceId: z.string().transform(value => value as NonNullable<ProjectSelectionProjection['workspaceId']>).optional(),
  automaticMutationEligible: z.boolean(),
  blockingReasons: z.array(z.enum(['dirty', 'baseline-unavailable', 'conversion-ambiguous', 'locked'])).max(4),
  fingerprint: projectInspectionFingerprintSchema,
  baseline: inheritedChangeBaselineSchema,
}).strict().superRefine((value, context) => {
  const expectedObjectLength = refineGitHeadObjectFormat(value, context)
  if (value.upstream !== undefined && value.head.symbolicRef === undefined) {
    context.addIssue({ code: 'custom', message: 'upstream requires an attached branch', path: ['upstream'] })
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
      if (objects.some(object => object.length !== expectedObjectLength)) {
        context.addIssue({ code: 'custom', message: 'baseline object does not match object format', path: ['baseline', 'entries', index] })
      }
    }
  }
  const remoteKeys = value.remotes.map(safeGitRemoteObservationKey)
  if (new Set(remoteKeys).size !== remoteKeys.length
    || value.remotes.some((remote, index) => {
      const previous = value.remotes.at(index - 1)
      return index > 0 && previous !== undefined && compareSafeGitRemoteObservations(previous, remote) > 0
    })) {
    context.addIssue({ code: 'custom', message: 'remote observations are not unique and canonical' })
  }
  const expectedCandidates = deriveGitHubRepositoryCandidates(value.remotes)
  const candidates = value.githubRepositoryCandidates
  if (expectedCandidates.length === 0
    ? candidates !== undefined
    : candidates === undefined
      || candidates.length !== expectedCandidates.length
      || candidates.some((candidate, index) => candidate !== expectedCandidates[index])) {
    context.addIssue({ code: 'custom', message: 'GitHub repository candidates disagree with remote observations' })
  }
}) as unknown as z.ZodType<ProjectSelectionProjection>

/** Trusted path observation retained outside browser JSON. */
export const trustedProjectSelectionObservationSchema = z.object({
  canonicalWorktreePath: z.string().min(1).max(MAX_TRUSTED_PATH_CHARS).refine(isAbsoluteHostPath),
  canonicalGitDirectory: z.string().min(1).max(MAX_TRUSTED_PATH_CHARS).refine(isAbsoluteHostPath),
  canonicalCommonGitDirectory: z.string().min(1).max(MAX_TRUSTED_PATH_CHARS).refine(isAbsoluteHostPath),
  gitDirectoryIdentity: z.object({ version: z.literal(1), digest }).strict(),
  commonGitDirectoryIdentity: z.object({ version: z.literal(1), digest }).strict(),
  comparison: z.object({
    fileMode: z.boolean(),
    symlinks: z.boolean(),
    autocrlf: z.boolean(),
  }).strict(),
}).strict()

/** Complete in-process inspection value. */
export const projectSelectionInspectionSchema: z.ZodType<ProjectSelectionInspection> = z.object({
  projection: projectSelectionProjectionSchema,
  trusted: trustedProjectSelectionObservationSchema,
}).strict().superRefine((value, context) => {
  const expected = computeProjectInspectionFingerprint(value.projection, value.trusted)
  if (expected.digest !== value.projection.fingerprint.digest) {
    context.addIssue({
      code: 'custom',
      message: 'inspection fingerprint disagrees with retained evidence',
      path: ['projection', 'fingerprint'],
    })
  }
})

/** Revisioned active Resource Binding evidence supplied to a Host operation. */
export const activeHostProjectBindingSchema: z.ZodType<ActiveHostProjectBinding> = z.object({
  id: sakiResourceBindingIdSchema,
  revision: nonnegative,
  health: z.literal('active'),
  hostId: hostId.transform(value => value as ActiveHostProjectBinding['hostId']),
  workspaceId: workspaceIdSchema,
  expectedInspection: projectSelectionInspectionSchema,
  inheritedChangeBaseline: inheritedChangeBaselineSchema,
}).strict().superRefine((value, context) => {
  if (value.expectedInspection.projection.hostId !== value.hostId) {
    context.addIssue({ code: 'custom', message: 'binding inspection belongs to another Host' })
  }
  const expectedBaseline = canonicalDigest(
    'saki/inherited-baseline/identity/v1',
    inheritedChangeBaselineIdentityMaterial(value.expectedInspection.projection.baseline),
  )
  const actualBaseline = canonicalDigest(
    'saki/inherited-baseline/identity/v1',
    inheritedChangeBaselineIdentityMaterial(value.inheritedChangeBaseline),
  )
  if (expectedBaseline !== actualBaseline) {
    context.addIssue({ code: 'custom', message: 'binding inherited baseline differs from registration evidence' })
  }
})

/** Versioned structured Git-status digest. */
export const projectGitStatusFingerprintSchema: z.ZodType<ProjectGitStatusFingerprint> = z.object({
  version: z.literal(1),
  digest,
}).strict()

/** Versioned digest of one exact public change row. */
export const projectGitChangeFingerprintSchema = z.object({
  version: z.literal(1),
  digest,
}).strict()

/** Versioned digest over one complete current worktree observation. */
export const projectGitWorktreeFingerprintSchema: z.ZodType<ProjectGitWorktreeFingerprint> = z.object({
  version: z.literal(1),
  digest,
}).strict()

/** Complete mergeable tree or unmerged-stage index evidence. */
export const projectGitIndexEvidenceSchema: z.ZodType<ProjectGitIndexEvidence> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tree'), treeId: gitObject }).strict(),
  z.object({
    kind: z.literal('unmerged'),
    stagesDigest: z.object({ version: z.literal(1), digest }).strict(),
  }).strict(),
])

const statusObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
const statusGitObjectSlotSchema = z.object({ mode: gitMode, objectId: statusObjectId }).strict()
const projectGitSubmoduleStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-submodule') }).strict(),
  z.object({
    kind: z.literal('submodule'),
    commit: z.enum(['changed', 'unchanged', 'unknown']),
  }).strict(),
])
const projectGitWorktreeEvidenceSchema = z.union([
  inheritedCurrentWorktreeEvidenceSchema,
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum([
      'entry-limit', 'path-limit', 'git-output-limit', 'file-limit', 'hash-limit', 'time-limit',
      'invalid-utf8', 'duplicate-path', 'unsupported-state', 'unstable-content', 'io-failure',
    ]),
  }).strict(),
])
const projectGitChangeBaseShape = {
  id: projectGitChangeIdSchema,
  path: z.string().min(1).max(MAX_PROJECT_GIT_STATUS_PATH_BYTES).refine(isRepositoryRelativeGitPath),
  attribution: z.enum(['inherited', 'not-inherited', 'unattributed']),
  fingerprint: projectGitChangeFingerprintSchema,
} as const

function worktreeEvidenceMode(
  evidence: Exclude<ProjectGitWorktreeEvidence, { readonly kind: 'unavailable' }>,
): '000000' | '100644' | '100755' | '120000' | '160000' {
  switch (evidence.kind) {
    case 'missing': return '000000'
    case 'regular': return evidence.mode
    case 'symlink': return '120000'
    case 'submodule': return '160000'
  }
}

function gitModeKind(mode: '000000' | '100644' | '100755' | '120000' | '160000'):
'missing' | 'regular' | 'symlink' | 'submodule' {
  if (mode === '000000') return 'missing'
  if (mode === '120000') return 'symlink'
  if (mode === '160000') return 'submodule'
  return 'regular'
}

function ordinaryIndexStatusMatches(value: Extract<ProjectGitChange, { readonly kind: 'ordinary' }>): boolean {
  const headMissing = value.head.mode === '000000'
  const indexMissing = value.index.mode === '000000'
  switch (value.indexStatus) {
    case 'unchanged':
      return headMissing && indexMissing
        ? value.worktreeStatus === 'added'
        : value.head.mode === value.index.mode && value.head.objectId === value.index.objectId
    case 'added': return headMissing && !indexMissing
    case 'deleted': return !headMissing && indexMissing
    case 'modified':
      return gitModeKind(value.head.mode) === gitModeKind(value.index.mode)
        && !headMissing && !indexMissing
        && (value.head.mode !== value.index.mode || value.head.objectId !== value.index.objectId)
    case 'type-changed':
      return gitModeKind(value.head.mode) !== gitModeKind(value.index.mode)
        && !headMissing && !indexMissing
  }
}

function ordinaryWorktreeStatusMatches(value: Extract<ProjectGitChange, { readonly kind: 'ordinary' }>): boolean {
  const indexMissing = value.index.mode === '000000'
  const worktreeMissing = value.worktreeMode === '000000'
  switch (value.worktreeStatus) {
    case 'unchanged': return value.index.mode === value.worktreeMode
    case 'added': return indexMissing && !worktreeMissing
    case 'deleted': return !indexMissing && worktreeMissing
    case 'modified':
      return !indexMissing && !worktreeMissing
        && gitModeKind(value.index.mode) === gitModeKind(value.worktreeMode)
    case 'type-changed':
      return !indexMissing && !worktreeMissing
        && gitModeKind(value.index.mode) !== gitModeKind(value.worktreeMode)
  }
}

/** One bounded exact repository-relative changed path. */
export const projectGitChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    ...projectGitChangeBaseShape,
    kind: z.literal('ordinary'),
    indexStatus: z.enum(['unchanged', 'modified', 'type-changed', 'added', 'deleted']),
    worktreeStatus: z.enum(['unchanged', 'modified', 'type-changed', 'added', 'deleted']),
    submodule: projectGitSubmoduleStatusSchema,
    head: statusGitObjectSlotSchema,
    index: statusGitObjectSlotSchema,
    worktreeMode: gitMode,
    worktreeEvidence: projectGitWorktreeEvidenceSchema,
  }).strict(),
  z.object({
    ...projectGitChangeBaseShape,
    kind: z.literal('untracked'),
    indexStatus: z.literal('absent'),
    worktreeStatus: z.literal('untracked'),
    submodule: z.object({ kind: z.literal('not-submodule') }).strict(),
    worktreeMode: z.enum(['100644', '100755', '120000', 'unknown']),
    worktreeEvidence: projectGitWorktreeEvidenceSchema,
  }).strict(),
  z.object({
    ...projectGitChangeBaseShape,
    kind: z.literal('unmerged'),
    indexStatus: z.literal('unmerged'),
    worktreeStatus: z.enum(['present', 'absent']),
    conflict: z.enum([
      'both-deleted', 'added-by-us', 'deleted-by-them', 'added-by-them',
      'deleted-by-us', 'both-added', 'both-modified',
    ]),
    submodule: projectGitSubmoduleStatusSchema,
    stages: z.object({
      base: statusGitObjectSlotSchema,
      ours: statusGitObjectSlotSchema,
      theirs: statusGitObjectSlotSchema,
    }).strict(),
    worktreeMode: gitMode,
    worktreeEvidence: projectGitWorktreeEvidenceSchema,
  }).strict(),
]).superRefine((value, context) => {
  if (value.kind === 'ordinary') {
    if (value.indexStatus === 'unchanged' && value.worktreeStatus === 'unchanged') {
      context.addIssue({ code: 'custom', message: 'ordinary status row has no change' })
    }
    if ((value.worktreeStatus === 'deleted') !== (value.worktreeMode === '000000')) {
      const stagedDeletion = value.worktreeStatus === 'unchanged'
        && value.index.mode === '000000'
        && value.worktreeMode === '000000'
      if (!stagedDeletion) context.addIssue({ code: 'custom', message: 'ordinary worktree mode disagrees with state' })
    }
    if (value.worktreeEvidence.kind !== 'unavailable'
      && (value.worktreeEvidence.kind === 'missing') !== (value.worktreeMode === '000000')) {
      context.addIssue({ code: 'custom', message: 'ordinary worktree presence disagrees with evidence' })
    }
    if (!ordinaryIndexStatusMatches(value)) {
      context.addIssue({ code: 'custom', message: 'ordinary index status disagrees with object slots' })
    }
    if (!ordinaryWorktreeStatusMatches(value)) {
      context.addIssue({ code: 'custom', message: 'ordinary worktree status disagrees with modes' })
    }
    const gitlink = value.head.mode === '160000' || value.index.mode === '160000'
      || value.worktreeMode === '160000' || value.worktreeEvidence.kind === 'submodule'
    if ((value.submodule.kind === 'submodule') !== gitlink) {
      context.addIssue({ code: 'custom', message: 'ordinary submodule facts disagree with gitlink modes' })
    }
  } else if (value.kind === 'untracked') {
    if (value.worktreeEvidence.kind === 'missing' || value.worktreeEvidence.kind === 'submodule') {
      context.addIssue({ code: 'custom', message: 'untracked worktree evidence is impossible' })
    }
    const expectedMode = value.worktreeEvidence.kind === 'unavailable'
      ? 'unknown'
      : worktreeEvidenceMode(value.worktreeEvidence)
    if (value.worktreeMode !== expectedMode) {
      context.addIssue({ code: 'custom', message: 'untracked worktree mode disagrees with evidence' })
    }
  } else {
    if ((value.worktreeStatus === 'absent') !== (value.worktreeMode === '000000')) {
      context.addIssue({ code: 'custom', message: 'unmerged worktree mode disagrees with presence' })
    }
    if (value.worktreeEvidence.kind !== 'unavailable'
      && (value.worktreeEvidence.kind === 'missing') !== (value.worktreeMode === '000000')) {
      context.addIssue({ code: 'custom', message: 'unmerged worktree presence disagrees with evidence' })
    }
    const present = [value.stages.base, value.stages.ours, value.stages.theirs]
      .map(slot => slot.mode === '000000' ? '0' : '1').join('')
    const expected = {
      'both-deleted': '100', 'added-by-us': '010', 'deleted-by-them': '110',
      'added-by-them': '001', 'deleted-by-us': '101', 'both-added': '011',
      'both-modified': '111',
    }[value.conflict]
    if (present !== expected) context.addIssue({ code: 'custom', message: 'unmerged stages disagree with conflict' })
    const gitlink = [value.stages.base, value.stages.ours, value.stages.theirs]
      .some(slot => slot.mode === '160000')
      || value.worktreeMode === '160000' || value.worktreeEvidence.kind === 'submodule'
    if ((value.submodule.kind === 'submodule') !== gitlink) {
      context.addIssue({ code: 'custom', message: 'unmerged submodule facts disagree with gitlink modes' })
    }
  }
  if (value.submodule.kind === 'submodule') {
    const commit = value.kind === 'ordinary' && value.index.mode === '160000'
      && value.worktreeEvidence.kind === 'submodule'
      ? value.index.objectId === value.worktreeEvidence.objectId ? 'unchanged' : 'changed'
      : 'unknown'
    if (value.submodule.commit !== commit) {
      context.addIssue({ code: 'custom', message: 'submodule commit state disagrees with retained objects' })
    }
  }
  const { id: _id, fingerprint: _fingerprint, ...material } = value
  if (computeProjectGitChangeFingerprint(material).digest !== value.fingerprint.digest) {
    context.addIssue({ code: 'custom', message: 'change fingerprint disagrees with row evidence', path: ['fingerprint'] })
  }
}) as unknown as z.ZodType<ProjectGitChange>

function statusPathsFitUtf8Budget(changes: readonly unknown[]): boolean {
  let remainingBytes = MAX_PROJECT_GIT_STATUS_PATH_BYTES
  for (const change of changes) {
    if (typeof change !== 'object' || change === null || !('path' in change)) continue
    const path = change.path
    if (typeof path !== 'string') continue
    if (path.length > remainingBytes) return false
    const pathBytes = UTF8.encode(path).byteLength
    if (pathBytes > remainingBytes) return false
    remainingBytes -= pathBytes
  }
  return true
}

const projectGitChangesSchema = z.custom<unknown[]>(
  (value): value is unknown[] => Array.isArray(value),
  { message: 'status changes must be an array', abort: true },
).pipe(z.custom<unknown[]>(
  (value): value is unknown[] => Array.isArray(value)
    && value.length <= MAX_PROJECT_GIT_STATUS_CHANGES,
  { message: 'status changes exceed the protocol row limit', abort: true },
)).pipe(z.custom<unknown[]>(
  (value): value is unknown[] => Array.isArray(value) && statusPathsFitUtf8Budget(value),
  { message: 'status paths exceed the protocol byte limit', abort: true },
)).pipe(z.array(projectGitChangeSchema).max(MAX_PROJECT_GIT_STATUS_CHANGES))

const projectGitMutationBlockerSchema = z.enum([
  'baseline-unavailable', 'conversion-ambiguous', 'current-unavailable', 'index-flags', 'unmerged', 'locked',
])
const MUTATION_BLOCKER_ORDER = [
  'baseline-unavailable', 'conversion-ambiguous', 'current-unavailable', 'index-flags', 'unmerged', 'locked',
] as const
/** Structured-mutation availability carried by one complete status observation. */
export const projectGitMutationAvailabilitySchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), blockers: z.tuple([]) }).strict(),
  z.object({
    available: z.literal(false),
    blockers: z.array(projectGitMutationBlockerSchema).min(1).max(MUTATION_BLOCKER_ORDER.length),
  }).strict(),
]).superRefine((value, context) => {
  if (!value.available) {
    const expected = [...new Set(value.blockers)]
      .sort((left, right) => MUTATION_BLOCKER_ORDER.indexOf(left) - MUTATION_BLOCKER_ORDER.indexOf(right))
    if (expected.length !== value.blockers.length
      || expected.some((blocker, index) => blocker !== value.blockers[index])) {
      context.addIssue({ code: 'custom', message: 'mutation blockers are not unique and canonical' })
    }
  }
})

/** Complete canonical structured Git status for one Resource Binding revision. */
export const projectGitStatusObservationSchema: z.ZodType<ProjectGitStatusObservation> = z.object({
  observationVersion: z.literal(1),
  observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bindingId: sakiResourceBindingIdSchema,
  bindingRevision: nonnegative,
  bindingHealth: z.literal('active'),
  locked: z.boolean(),
  objectFormat: z.enum(['sha1', 'sha256']),
  head: projectGitHeadSchema,
  branch: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('attached'),
      ref: z.string().min(1).max(MAX_GIT_REF_CHARS).refine(isSafeGitRef),
      name: z.string().min(1).max(MAX_GIT_REF_CHARS).refine(isSafeGitBranchName),
    }).strict(),
    z.object({ kind: z.literal('detached') }).strict(),
  ]),
  upstream: z.object({
    ref: z.string().min(1).max(MAX_GIT_REF_CHARS).refine(isSafeGitRef),
    name: z.string().min(1).max(MAX_GIT_REF_CHARS).refine(value => !/[\u0000-\u0020\u007f]/u.test(value)),
    divergence: z.object({ ahead: nonnegative, behind: nonnegative }).strict().optional(),
  }).strict().optional(),
  index: projectGitIndexEvidenceSchema,
  worktree: projectGitWorktreeFingerprintSchema,
  changes: projectGitChangesSchema,
  structuredMutation: projectGitMutationAvailabilitySchema,
  fingerprint: projectGitStatusFingerprintSchema,
}).strict().superRefine((value, context) => {
  const expectedObjectLength = refineGitHeadObjectFormat(value, context)
  if (value.branch.kind === 'attached') {
    if (value.head.symbolicRef !== value.branch.ref
      || value.branch.ref !== `refs/heads/${value.branch.name}`) {
      context.addIssue({ code: 'custom', message: 'attached branch disagrees with HEAD', path: ['branch'] })
    }
  } else if (value.head.kind === 'unborn' || value.head.symbolicRef !== undefined) {
    context.addIssue({ code: 'custom', message: 'detached branch disagrees with HEAD', path: ['branch'] })
  }
  if (value.upstream !== undefined && value.branch.kind !== 'attached') {
    context.addIssue({ code: 'custom', message: 'upstream requires an attached branch', path: ['upstream'] })
  }
  if (value.index.kind === 'tree' && value.index.treeId.length !== expectedObjectLength) {
    context.addIssue({ code: 'custom', message: 'index tree does not match object format', path: ['index', 'treeId'] })
  }
  const unmerged = value.changes.some(change => change.kind === 'unmerged')
  if ((value.index.kind === 'unmerged') !== unmerged) {
    context.addIssue({ code: 'custom', message: 'index evidence disagrees with unmerged rows', path: ['index'] })
  }
  const hasUnmergedBlocker = !value.structuredMutation.available
    && value.structuredMutation.blockers.includes('unmerged')
  if (hasUnmergedBlocker !== unmerged) {
    context.addIssue({ code: 'custom', message: 'unmerged blocker disagrees with index state', path: ['structuredMutation'] })
  }
  const hasUnavailableRow = value.changes.some(change => change.worktreeEvidence.kind === 'unavailable')
  const hasCurrentUnavailableBlocker = !value.structuredMutation.available
    && value.structuredMutation.blockers.includes('current-unavailable')
  if (hasUnavailableRow !== hasCurrentUnavailableBlocker) {
    context.addIssue({
      code: 'custom',
      message: 'current-evidence blocker disagrees with unavailable rows',
      path: ['structuredMutation'],
    })
  }
  const hasLockedBlocker = !value.structuredMutation.available
    && value.structuredMutation.blockers.includes('locked')
  if (hasLockedBlocker !== value.locked) {
    context.addIssue({ code: 'custom', message: 'locked blocker disagrees with binding status', path: ['structuredMutation'] })
  }
  if (value.structuredMutation.available && unmerged) {
    context.addIssue({ code: 'custom', message: 'mutation availability ignores unknown change evidence' })
  }
  const statusSeedDigest = computeProjectGitStatusSeedDigest(
    projectGitStatusSeedMaterial(value as ProjectGitStatusObservation),
  )
  for (const [index, change] of value.changes.entries()) {
    const previous = value.changes.at(index - 1)
    if (index > 0 && previous !== undefined && compareRepositoryRelativeGitPaths(previous.path, change.path) >= 0) {
      context.addIssue({ code: 'custom', message: 'status paths are not unique and canonical', path: ['changes', index, 'path'] })
    }
    const { id: _id, ...material } = change
    if (computeProjectGitChangeId(statusSeedDigest, material) !== change.id) {
      context.addIssue({ code: 'custom', message: 'change id disagrees with status evidence', path: ['changes', index, 'id'] })
    }
    const slots = change.kind === 'ordinary'
      ? [change.head, change.index]
      : change.kind === 'unmerged'
        ? [change.stages.base, change.stages.ours, change.stages.theirs]
        : []
    for (const [slotIndex, slot] of slots.entries()) {
      const missing = slot.mode === '000000'
      if (slot.objectId.length !== expectedObjectLength || missing !== /^0+$/u.test(slot.objectId)) {
        context.addIssue({
          code: 'custom',
          message: 'change object slot disagrees with mode or object format',
          path: ['changes', index, 'object', slotIndex],
        })
      }
    }
    if (change.worktreeEvidence.kind === 'submodule'
      && change.worktreeEvidence.objectId.length !== expectedObjectLength) {
      context.addIssue({
        code: 'custom',
        message: 'worktree submodule object disagrees with object format',
        path: ['changes', index, 'worktreeEvidence', 'objectId'],
      })
    }
  }
  if (computeProjectGitStatusFingerprint(value as ProjectGitStatusObservation).digest !== value.fingerprint.digest) {
    context.addIssue({ code: 'custom', message: 'status fingerprint disagrees with retained evidence', path: ['fingerprint'] })
  }
}) as unknown as z.ZodType<ProjectGitStatusObservation>

/** Opaque provider-owned continuation token for a bounded Diff. */
export const projectGitDiffCursorSchema = z.string()
  .min(1)
  .max(MAX_PROJECT_GIT_DIFF_CURSOR_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .transform(value => value as ProjectGitDiffCursor)

/** Closed index side available to file-scoped Diff reads. */
export const projectGitDiffLayerSchema = z.enum(['staged', 'unstaged', 'conflict'])

/** Versioned digest of one complete raw patch. */
export const projectGitPatchFingerprintSchema: z.ZodType<ProjectGitPatchFingerprint> = z.object({
  version: z.literal(1),
  digest,
}).strict()

const safeNonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const diffLineSchema = z.string()
  .max(MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES - 1)
  .refine(value => !value.includes('\n') && !value.includes('\0') && value.isWellFormed())
  .refine(value => UTF8.encode(value).byteLength + 1 <= MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES)

/** One internally consistent bounded page of LF-terminated unified Diff lines. */
export const projectGitDiffPageSchema: z.ZodType<ProjectGitDiffPage> = z.object({
  pageVersion: z.literal(1),
  observation: projectGitStatusFingerprintSchema,
  changeId: projectGitChangeIdSchema,
  layer: projectGitDiffLayerSchema,
  patchFingerprint: projectGitPatchFingerprintSchema,
  range: z.object({
    startLine: safeNonnegative.max(MAX_PROJECT_GIT_DIFF_TOTAL_LINES),
    endLineExclusive: safeNonnegative.max(MAX_PROJECT_GIT_DIFF_TOTAL_LINES),
    totalLines: safeNonnegative.positive().max(MAX_PROJECT_GIT_DIFF_TOTAL_LINES),
  }).strict(),
  lines: z.array(diffLineSchema).min(1).max(MAX_PROJECT_GIT_DIFF_PAGE_LINES),
  pageUtf8Bytes: safeNonnegative.positive().max(MAX_PROJECT_GIT_DIFF_PAGE_UTF8_BYTES),
  totalUtf8Bytes: safeNonnegative.positive().max(MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES),
  omittedBeforeLines: safeNonnegative.max(MAX_PROJECT_GIT_DIFF_TOTAL_LINES),
  omittedAfterLines: safeNonnegative.max(MAX_PROJECT_GIT_DIFF_TOTAL_LINES),
  truncated: z.boolean(),
  nextCursor: projectGitDiffCursorSchema.optional(),
}).strict().superRefine((value, context) => {
  const pageUtf8Bytes = value.lines.reduce(
    (bytes, line) => bytes + UTF8.encode(line).byteLength + 1,
    0,
  )
  if (value.pageUtf8Bytes !== pageUtf8Bytes) {
    context.addIssue({ code: 'custom', message: 'page byte total disagrees with Diff lines', path: ['pageUtf8Bytes'] })
  }
  if (value.range.startLine !== value.omittedBeforeLines
    || value.range.endLineExclusive !== value.range.startLine + value.lines.length
    || value.range.totalLines !== value.range.endLineExclusive + value.omittedAfterLines) {
    context.addIssue({ code: 'custom', message: 'Diff range disagrees with returned and omitted lines', path: ['range'] })
  }
  const minimumTotalBytes = pageUtf8Bytes + value.omittedBeforeLines + value.omittedAfterLines
  if (value.totalUtf8Bytes < minimumTotalBytes
    || (value.omittedBeforeLines === 0 && value.omittedAfterLines === 0
      && value.totalUtf8Bytes !== pageUtf8Bytes)) {
    context.addIssue({ code: 'custom', message: 'complete Diff byte total disagrees with the page', path: ['totalUtf8Bytes'] })
  }
  const truncated = value.omittedBeforeLines > 0 || value.omittedAfterLines > 0
  if (value.truncated !== truncated) {
    context.addIssue({ code: 'custom', message: 'Diff truncation flag disagrees with omitted lines', path: ['truncated'] })
  }
  if ((value.nextCursor !== undefined) !== (value.omittedAfterLines > 0)) {
    context.addIssue({ code: 'custom', message: 'Diff continuation disagrees with omitted trailing lines', path: ['nextCursor'] })
  }
}) as unknown as z.ZodType<ProjectGitDiffPage>

/** Strict file-scoped Diff request with no caller-controlled path or Git command data. */
export const readProjectDiffRequestSchema: z.ZodType<ReadProjectDiffRequest> = z.object({
  expectedStatus: projectGitStatusFingerprintSchema,
  changeId: projectGitChangeIdSchema,
  layer: projectGitDiffLayerSchema,
  cursor: projectGitDiffCursorSchema.optional(),
}).strict() as unknown as z.ZodType<ReadProjectDiffRequest>

/** Strict internal envelope pairing trusted binding evidence with one Diff request. */
export const readProjectDiffOperationRequestSchema: z.ZodType<ReadProjectDiffOperationRequest> = z.object({
  binding: activeHostProjectBindingSchema,
  request: readProjectDiffRequestSchema,
}).strict()

/** Closed Host file-scoped Diff result. */
export const readProjectDiffResultSchema: z.ZodType<ReadProjectDiffResult> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), page: projectGitDiffPageSchema }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'binding-stale', 'observation-stale', 'change-missing', 'change-ambiguous', 'layer-missing',
      'invalid-cursor', 'cursor-stale', 'total-bytes', 'total-lines', 'line-bytes', 'time',
      'untracked', 'conflict', 'binary', 'command-length', 'invalid-utf8', 'malformed', 'ambiguous', 'unavailable',
    ]),
  }).strict(),
])

/** Immutable direct-Control-Intent source of one structured Git Host Operation. */
export const controlIntentHostOperationSourceSchema = z.object({
  kind: z.literal('control-intent'),
  intentId: sakiControlIntentIdSchema,
  intentRevision: safeNonnegative,
  payloadDigest: digest,
}).strict() satisfies z.ZodType<ControlIntentHostOperationSource>

/** Immutable Execution Dispatch source of one Agent-start Host Operation. */
export const executionDispatchHostOperationSourceSchema = z.object({
  kind: z.literal('execution-dispatch'),
  dispatchId: sakiExecutionDispatchIdSchema,
  payloadDigest: digest,
}).strict() satisfies z.ZodType<ExecutionDispatchHostOperationSource>

/** Closed current Host Operation source union. */
export const hostOperationSourceSchema = z.discriminatedUnion('kind', [
  controlIntentHostOperationSourceSchema,
  executionDispatchHostOperationSourceSchema,
]) satisfies z.ZodType<HostOperationSource>

/** Exact complete Git evidence required before one writable Host operation. */
export const hostGitMutationPreconditionSchema: z.ZodType<HostGitMutationPrecondition> = z.object({
  binding: activeHostProjectBindingSchema,
  status: projectGitStatusFingerprintSchema,
  head: projectGitHeadSchema,
  index: z.object({ kind: z.literal('tree'), treeId: gitObject }).strict(),
  worktree: projectGitWorktreeFingerprintSchema,
  preEffectBaseline: completeInheritedChangeBaselineSchema,
}).strict().superRefine((value, context) => {
  const objectWidth = value.binding.expectedInspection.projection.objectFormat === 'sha1' ? 40 : 64
  if (value.head.kind === 'commit' && value.head.objectId.length !== objectWidth) {
    context.addIssue({ code: 'custom', message: 'expected HEAD disagrees with binding object format', path: ['head'] })
  }
  if (value.index.treeId.length !== objectWidth) {
    context.addIssue({ code: 'custom', message: 'expected index disagrees with binding object format', path: ['index'] })
  }
})

/** Observation-scoped selected change without caller-supplied path authority. */
export const selectedProjectGitChangeSchema: z.ZodType<SelectedProjectGitChange> = z.object({
  id: projectGitChangeIdSchema,
  fingerprint: projectGitChangeFingerprintSchema,
}).strict()

const selectedProjectGitChangesSchema = z.custom<unknown[]>(
  (value): value is unknown[] => Array.isArray(value),
  { message: 'Host Operation selection must be an array', abort: true },
).pipe(z.custom<unknown[]>(
  (value): value is unknown[] => Array.isArray(value)
    && value.length <= MAX_HOST_OPERATION_SELECTED_CHANGES,
  { message: 'Host Operation selection exceeds the protocol row limit', abort: true },
)).pipe(z.array(selectedProjectGitChangeSchema)
  .min(1)
  .max(MAX_HOST_OPERATION_SELECTED_CHANGES))
  .superRefine((changes, context) => {
    if (new Set(changes.map(change => change.id)).size !== changes.length) {
      context.addIssue({ code: 'custom', message: 'Host Operation selection repeats a change id' })
    }
  })

const gitHostOperationRequestBaseShape = {
  source: controlIntentHostOperationSourceSchema,
  expected: hostGitMutationPreconditionSchema,
} as const

/** Strict StageFiles request; paths remain Host-resolved. */
export const stageFilesHostOperationRequestSchema = z.object({
  type: z.literal('stage-files'),
  ...gitHostOperationRequestBaseShape,
  changes: selectedProjectGitChangesSchema,
}).strict() satisfies z.ZodType<StageFilesHostOperationRequest>

/** Strict UnstageFiles request; paths remain Host-resolved. */
export const unstageFilesHostOperationRequestSchema = z.object({
  type: z.literal('unstage-files'),
  ...gitHostOperationRequestBaseShape,
  changes: selectedProjectGitChangesSchema,
}).strict() satisfies z.ZodType<UnstageFilesHostOperationRequest>

const commitMessageSchema = z.string()
  .min(1)
  .max(MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES)
  .pipe(z.string()
    .refine(value => !value.includes('\0') && value.isWellFormed())
    .refine(value => UTF8.encode(value).byteLength <= MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES))

/** Strict deterministic Commit request with no caller identity or ref authority. */
export const commitHostOperationRequestSchema = z.object({
  type: z.literal('commit'),
  ...gitHostOperationRequestBaseShape,
  message: commitMessageSchema,
}).strict() satisfies z.ZodType<CommitHostOperationRequest>

const githubRepositoryCoordinatesSchema = z.object({
  nameWithOwner: z.string()
    .min(3)
    .max(201)
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
    .refine(value => value.split('/').every(component => component !== '.' && component !== '..')),
}).strict()

const githubBranchRefSchema = z.string()
  .min('refs/heads/a'.length)
  .max(MAX_GIT_REF_CHARS)
  .refine(value => value.startsWith('refs/heads/') && isSafeGitRef(value))

/** Strict PushBranch request without caller-controlled URL or credential-helper authority. */
export const pushBranchHostOperationRequestSchema = z.object({
  type: z.literal('push-branch'),
  source: controlIntentHostOperationSourceSchema,
  expected: z.object({
    binding: activeHostProjectBindingSchema,
    commitId: gitObject,
    repository: githubRepositoryCoordinatesSchema,
  }).strict(),
  targetRef: githubBranchRefSchema,
}).strict().superRefine((value, context) => {
  const objectWidth = value.expected.binding.expectedInspection.projection.objectFormat === 'sha1' ? 40 : 64
  if (value.expected.commitId.length !== objectWidth) {
    context.addIssue({
      code: 'custom',
      message: 'expected commit disagrees with binding object format',
      path: ['expected', 'commitId'],
    })
  }
}) satisfies z.ZodType<PushBranchHostOperationRequest>

const productUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const startAgentRunMessageIdSchema = z.string().regex(productUuid)
  .transform(value => value as StartAgentRunInputMessage['id'])
const startAgentRunSessionIdSchema = z.string()
  .regex(/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
  .transform(value => value as StartAgentRunHostOperationRequest['run']['sessionId'])
const startAgentRunTextSchema = z.string()
  .min(1)
  .max(MAX_START_AGENT_RUN_INPUT_UTF8_BYTES)
  .refine(value => value.isWellFormed() && !value.includes('\0'))
  .refine(value => UTF8.encode(value).byteLength <= MAX_START_AGENT_RUN_INPUT_UTF8_BYTES)

/** Exact bounded request for durable Intervention-opening evidence. */
export const inspectInterventionOpeningRequestSchema: z.ZodType<InspectInterventionOpeningRequest> = z.object({
  hostId: hostId.transform(value => value as InspectInterventionOpeningRequest['hostId']),
  sessionId: startAgentRunSessionIdSchema,
  callId: z.string().min(1).max(4_096)
    .transform(value => value as InspectInterventionOpeningRequest['callId']),
  interventionId: sakiInterventionRequestIdSchema,
  expectedQuestion: startAgentRunTextSchema,
  expectedToolResult: z.object({
    content: z.tuple([z.object({ type: z.literal('text'), text: startAgentRunTextSchema }).strict()]),
  }).strict(),
}).strict()

/** Closed browser-safe outcomes from durable Intervention-opening inspection. */
export const interventionOpeningEvidenceSchema: z.ZodType<InterventionOpeningEvidence> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('pending') }).strict(),
  z.object({ kind: z.literal('confirmed'), turn: positive, step: positive }).strict(),
  z.object({ kind: z.literal('conflict') }).strict(),
])

/** Exact provenance carried by one preallocated Agent Run input. */
export const sakiAgentRunMessageSourceSchema = z.object({
  kind: z.literal('saki-agent-run'),
  dispatchId: sakiExecutionDispatchIdSchema,
  agentRunId: sakiAgentRunIdSchema,
  workSessionId: sakiWorkSessionIdSchema,
}).strict()

/** Browser-safe immutable Actor attribution carried by one Intervention answer. */
export const sakiControlIntentActorAttributionSchema: z.ZodType<SakiControlIntentActorAttribution> = z.object({
  installationId: sakiInstallationIdSchema,
  storageGenerationId: sakiStorageGenerationIdSchema,
  hostId: hostId.transform(value => value as SakiControlIntentActorAttribution['hostId']),
  principalId: sakiPrincipalIdSchema,
  principalRevision: nonnegative,
  grantId: sakiGrantIdSchema,
  grantRevision: nonnegative,
}).strict()

/** Exact attributed provenance for an Intervention answer. */
export const sakiInterventionAnswerMessageSourceSchema: z.ZodType<SakiInterventionAnswerMessageSource> = z.object({
  kind: z.literal('saki-intervention-answer'),
  interventionId: sakiInterventionRequestIdSchema,
  answerIntentId: sakiControlIntentIdSchema,
  dispatchId: sakiExecutionDispatchIdSchema,
  agentRunId: sakiAgentRunIdSchema,
  workSessionId: sakiWorkSessionIdSchema,
  actor: sakiControlIntentActorAttributionSchema,
}).strict()

/** Current message provenance accepted by StartAgentRun. */
export const startAgentRunMessageSourceSchema = z.union([
  sakiAgentRunMessageSourceSchema,
  sakiInterventionAnswerMessageSourceSchema,
])

/** Exact initial-input UserMessage retained by `saki_host_execution@2`. */
export const startAgentRunInputMessageV2Schema: z.ZodType<StartAgentRunInputMessageV2> = z.object({
  id: startAgentRunMessageIdSchema,
  role: z.literal('user'),
  content: z.tuple([z.object({ type: z.literal('text'), text: startAgentRunTextSchema }).strict()]),
  source: sakiAgentRunMessageSourceSchema,
}).strict()

/** Exact text-only UserMessage delivered by StartAgentRun. */
export const startAgentRunInputMessageSchema: z.ZodType<StartAgentRunInputMessage> = z.object({
  id: startAgentRunMessageIdSchema,
  role: z.literal('user'),
  content: z.tuple([z.object({ type: z.literal('text'), text: startAgentRunTextSchema }).strict()]),
  source: startAgentRunMessageSourceSchema,
}).strict()

/** Immutable Development Agent Profile values mounted for one Run. */
export const startAgentRunProfileSchema: z.ZodType<StartAgentRunProfile> = z.object({
  id: sakiAgentProfileIdSchema,
  version: positive,
  agentPresetId: z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9-]*$/u),
  modelRoute: z.object({
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
  }).strict(),
}).strict()

function refineStartAgentRunRequestRelations(
  value: Pick<StartAgentRunHostOperationRequest, 'source' | 'run'>,
  context: z.RefinementCtx,
): void {
  if (value.run.input.source.dispatchId !== value.source.dispatchId) {
    context.addIssue({ code: 'custom', message: 'Agent Run input disagrees with its Dispatch', path: ['run', 'input', 'source', 'dispatchId'] })
  }
  if (value.run.input.source.agentRunId !== value.run.agentRunId) {
    context.addIssue({ code: 'custom', message: 'Agent Run input disagrees with its Run', path: ['run', 'input', 'source', 'agentRunId'] })
  }
  if (value.run.input.source.workSessionId !== value.run.workSessionId) {
    context.addIssue({ code: 'custom', message: 'Agent Run input disagrees with its Work Session', path: ['run', 'input', 'source', 'workSessionId'] })
  }
  if (computeStartAgentRunPayloadDigest(value.run.input) !== value.source.payloadDigest) {
    context.addIssue({ code: 'custom', message: 'Agent Run input disagrees with its payload digest', path: ['source', 'payloadDigest'] })
  }
}

/** Strict Agent-start request with full writable preconditions and frozen input. */
export const startAgentRunHostOperationRequestSchema = z.object({
  type: z.literal('start-agent-run'),
  source: executionDispatchHostOperationSourceSchema,
  expected: hostGitMutationPreconditionSchema,
  run: z.object({
    agentRunId: sakiAgentRunIdSchema,
    workSessionId: sakiWorkSessionIdSchema,
    sessionId: startAgentRunSessionIdSchema,
    profile: startAgentRunProfileSchema,
    input: startAgentRunInputMessageSchema,
  }).strict(),
}).strict().superRefine(refineStartAgentRunRequestRelations) satisfies z.ZodType<StartAgentRunHostOperationRequest>

/** Exact StartAgentRun request retained by `saki_host_execution@2`. */
export const startAgentRunHostOperationRequestV2Schema = z.object({
  type: z.literal('start-agent-run'),
  source: executionDispatchHostOperationSourceSchema,
  expected: hostGitMutationPreconditionSchema,
  run: z.object({
    agentRunId: sakiAgentRunIdSchema,
    workSessionId: sakiWorkSessionIdSchema,
    sessionId: startAgentRunSessionIdSchema,
    profile: startAgentRunProfileSchema,
    input: startAgentRunInputMessageV2Schema,
  }).strict(),
}).strict().superRefine(refineStartAgentRunRequestRelations) satisfies z.ZodType<StartAgentRunHostOperationRequestV2>

/** Closed current Host Operation request union. */
export const hostOperationRequestSchema = z.discriminatedUnion('type', [
  stageFilesHostOperationRequestSchema,
  unstageFilesHostOperationRequestSchema,
  commitHostOperationRequestSchema,
  pushBranchHostOperationRequestSchema,
  startAgentRunHostOperationRequestSchema,
]) satisfies z.ZodType<HostOperationRequest>

/** Exact Host Operation request union retained by `saki_host_execution@2`. */
export const hostOperationRequestV2Schema = z.discriminatedUnion('type', [
  stageFilesHostOperationRequestSchema,
  unstageFilesHostOperationRequestSchema,
  commitHostOperationRequestSchema,
  startAgentRunHostOperationRequestV2Schema,
]) satisfies z.ZodType<HostOperationRequestV2>

/** One selected change path resolved by the Host after observation matching. */
export const appliedProjectGitChangeSchema: z.ZodType<AppliedProjectGitChange> = z.object({
  id: projectGitChangeIdSchema,
  fingerprint: projectGitChangeFingerprintSchema,
  path: z.string().refine(isRepositoryRelativeGitPath),
}).strict()

const appliedProjectGitChangesSchema = z.custom<unknown[]>(
  (value): value is unknown[] => Array.isArray(value),
  { message: 'Host Operation result changes must be an array', abort: true },
).pipe(z.custom<unknown[]>(
  (value): value is unknown[] => Array.isArray(value)
    && value.length <= MAX_HOST_OPERATION_SELECTED_CHANGES,
  { message: 'Host Operation result changes exceed the protocol row limit', abort: true },
)).pipe(z.custom<unknown[]>(
  (value): value is unknown[] => Array.isArray(value) && statusPathsFitUtf8Budget(value),
  { message: 'Host Operation result paths exceed the protocol byte limit', abort: true },
)).pipe(z.array(appliedProjectGitChangeSchema)
  .min(1)
  .max(MAX_HOST_OPERATION_SELECTED_CHANGES))
  .superRefine((changes, context) => {
    if (new Set(changes.map(change => change.id)).size !== changes.length
      || new Set(changes.map(change => change.path)).size !== changes.length) {
      context.addIssue({ code: 'custom', message: 'Host Operation result repeats a selected change' })
    }
  })

const successfulIndexMutationShape = {
  changes: appliedProjectGitChangesSchema,
  resultingIndex: z.object({ kind: z.literal('tree'), treeId: gitObject }).strict(),
} as const

/** Stable evidence of one successful StageFiles publication. */
export const stageFilesHostOperationResultSchema = z.object({
  type: z.literal('stage-files'),
  ...successfulIndexMutationShape,
}).strict() satisfies z.ZodType<StageFilesHostOperationResult>

/** Stable evidence of one successful UnstageFiles publication. */
export const unstageFilesHostOperationResultSchema = z.object({
  type: z.literal('unstage-files'),
  ...successfulIndexMutationShape,
}).strict() satisfies z.ZodType<UnstageFilesHostOperationResult>

const commitSignatureSchema = z.object({
  name: z.string().min(1).max(1_024).refine(value => value.trim() !== ''
    && !/[\0\r\n<>]/u.test(value) && value.isWellFormed()),
  email: z.string().min(1).max(1_024).refine(value => value.trim() !== ''
    && !/[\0\r\n<>]/u.test(value) && value.isWellFormed()),
  timestamp: safeNonnegative,
  timezone: z.string().regex(/^[+-](?:0[0-9]|1[0-4])[0-5][0-9]$/u),
  source: z.literal('git-config'),
}).strict()

/** Stable evidence of one successful deterministic Commit publication. */
export const commitHostOperationResultSchema = z.object({
  type: z.literal('commit'),
  commitId: gitObject,
  treeId: gitObject,
  parent: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('commit'), objectId: gitObject }).strict(),
  ]),
  target: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('symbolic-ref'),
      ref: z.string().min(1).max(MAX_GIT_REF_CHARS)
        .refine(value => value.startsWith('refs/heads/') && isSafeGitRef(value)),
    }).strict(),
    z.object({ kind: z.literal('detached-head') }).strict(),
  ]),
  author: commitSignatureSchema,
  committer: commitSignatureSchema,
}).strict().superRefine((value, context) => {
  const width = value.commitId.length
  for (const [field, objectId] of [
    ['commitId', value.commitId],
    ['treeId', value.treeId],
    ...(value.parent.kind === 'commit' ? [['parent', value.parent.objectId] as const] : []),
  ] as const) {
    if (objectId.length !== width) {
      context.addIssue({ code: 'custom', message: `${field} uses a different object format`, path: [field] })
    }
  }
}) satisfies z.ZodType<CommitHostOperationResult>

const gitRemoteBranchStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('commit'), objectId: gitObject }).strict(),
])

/** Closed safe identities for supported non-interactive Git credential adapters. */
export const gitCredentialHelperIdSchema = z.enum([
  'git-credential-manager',
  'git-credential-manager-core',
])

/** Stable evidence of one successful exact-lease PushBranch publication. */
export const pushBranchHostOperationResultSchema = z.object({
  type: z.literal('push-branch'),
  repository: githubRepositoryCoordinatesSchema,
  targetRef: githubBranchRefSchema,
  commitId: gitObject,
  previous: gitRemoteBranchStateSchema,
  credential: z.object({ helperId: gitCredentialHelperIdSchema }).strict(),
}).strict().superRefine((value, context) => {
  if (value.previous.kind === 'commit' && value.previous.objectId.length !== value.commitId.length) {
    context.addIssue({
      code: 'custom',
      message: 'previous remote commit uses a different object format',
      path: ['previous', 'objectId'],
    })
  }
}) satisfies z.ZodType<PushBranchHostOperationResult>

/** Stable evidence that the intended Agent Run and dispatched input exist. */
const startAgentRunHostOperationResultObjectSchema = z.object({
  type: z.literal('start-agent-run'),
  agentRunId: sakiAgentRunIdSchema,
  workSessionId: sakiWorkSessionIdSchema,
  sessionId: startAgentRunSessionIdSchema,
  inputMessageId: startAgentRunMessageIdSchema,
}).strict() satisfies z.ZodType<StartAgentRunHostOperationResult>
/** Strict evidence schema for one durable Agent Run and its exact dispatched input. */
export const startAgentRunHostOperationResultSchema: z.ZodType<StartAgentRunHostOperationResult> =
  startAgentRunHostOperationResultObjectSchema

const hostOperationResultSchema = z.discriminatedUnion('type', [
  stageFilesHostOperationResultSchema,
  unstageFilesHostOperationResultSchema,
  commitHostOperationResultSchema,
  pushBranchHostOperationResultSchema,
  startAgentRunHostOperationResultObjectSchema,
])

/** Stable provider-routed Host Operation reference. */
export const hostOperationReferenceSchema: z.ZodType<HostOperationReference> = z.object({
  id: hostOperationIdSchema,
  hostId: hostId.transform(value => value as HostOperationReference['hostId']),
  type: z.enum(['stage-files', 'unstage-files', 'commit', 'push-branch', 'start-agent-run']),
}).strict()

/** Versioned immutable Host Operation request digest. */
export const hostOperationRequestFingerprintSchema: z.ZodType<HostOperationRequestFingerprint> = z.object({
  version: z.literal(1),
  digest,
}).strict()

/** Durable prepared-operation evidence safe outside the Provider. */
export const hostOperationPreparationSchema: z.ZodType<HostOperationPreparation> = z.object({
  operation: hostOperationReferenceSchema,
  preparationRevision: safeNonnegative,
  requestFingerprint: hostOperationRequestFingerprintSchema,
}).strict()

const hostOperationSnapshotBaseShape = {
  operation: hostOperationReferenceSchema,
  revision: safeNonnegative,
  source: hostOperationSourceSchema,
  requestFingerprint: hostOperationRequestFingerprintSchema,
  bindingId: sakiResourceBindingIdSchema,
  bindingRevision: safeNonnegative,
  preparedAt: safeNonnegative,
  updatedAt: safeNonnegative,
} as const

const notAcceptedAdmissionSchema = z.object({ kind: z.literal('not-accepted') }).strict()
const acceptedAdmissionSchema = z.object({
  kind: z.literal('accepted'),
  revision: safeNonnegative,
  acceptedAt: safeNonnegative,
}).strict()
const admissionEvidenceSchema = z.discriminatedUnion('kind', [
  notAcceptedAdmissionSchema,
  acceptedAdmissionSchema,
])

/** Durable Host Operation lifecycle; the nominal acceptance is intentionally absent. */
export const hostOperationSnapshotSchema: z.ZodType<HostOperationSnapshot> = z.discriminatedUnion('state', [
  z.object({
    ...hostOperationSnapshotBaseShape,
    state: z.literal('prepared'),
    admission: notAcceptedAdmissionSchema,
  }).strict(),
  z.object({
    ...hostOperationSnapshotBaseShape,
    state: z.literal('accepted'),
    admission: acceptedAdmissionSchema,
  }).strict(),
  z.object({
    ...hostOperationSnapshotBaseShape,
    state: z.literal('planning'),
    admission: acceptedAdmissionSchema,
    plannedAt: safeNonnegative,
  }).strict(),
  z.object({
    ...hostOperationSnapshotBaseShape,
    state: z.literal('publishing'),
    admission: acceptedAdmissionSchema,
    plannedAt: safeNonnegative,
    effectPlannedAt: safeNonnegative,
    publishingAt: safeNonnegative,
  }).strict(),
  z.object({
    ...hostOperationSnapshotBaseShape,
    state: z.literal('succeeded'),
    admission: acceptedAdmissionSchema,
    completedAt: safeNonnegative,
    result: hostOperationResultSchema,
  }).strict(),
  z.object({
    ...hostOperationSnapshotBaseShape,
    state: z.literal('failed'),
    admission: admissionEvidenceSchema,
    completedAt: safeNonnegative,
    failure: z.object({
      reason: z.enum([
        'binding-stale', 'observation-stale', 'invalid-selection',
        'unsupported-state',
      ]),
    }).strict(),
    effect: z.literal('none'),
  }).strict(),
  z.object({
    ...hostOperationSnapshotBaseShape,
    state: z.literal('canceled'),
    admission: admissionEvidenceSchema,
    completedAt: safeNonnegative,
    reason: z.enum(['source-canceled', 'authority-revoked']),
    effect: z.literal('none'),
  }).strict(),
  z.object({
    ...hostOperationSnapshotBaseShape,
    state: z.literal('reconciliation-required'),
    admission: acceptedAdmissionSchema,
    observedAt: safeNonnegative,
    reason: z.enum(['effect-unknown', 'evidence-conflict']),
  }).strict(),
]).superRefine((value, context) => {
  if (value.updatedAt < value.preparedAt) {
    context.addIssue({ code: 'custom', message: 'Host Operation update predates preparation', path: ['updatedAt'] })
  }
  const admissionTimestamp = value.admission.kind === 'accepted' ? [value.admission.acceptedAt] : []
  const timestamps = value.state === 'accepted'
    ? admissionTimestamp
    : value.state === 'planning'
      ? [...admissionTimestamp, value.plannedAt]
      : value.state === 'publishing'
        ? [...admissionTimestamp, value.plannedAt, value.effectPlannedAt, value.publishingAt]
        : value.state === 'succeeded' || value.state === 'failed' || value.state === 'canceled'
          ? [...admissionTimestamp, value.completedAt]
          : value.state === 'reconciliation-required' ? [...admissionTimestamp, value.observedAt] : []
  let previousTimestamp = value.preparedAt
  if (timestamps.some((timestamp) => {
    const notMonotonic = timestamp < previousTimestamp || timestamp > value.updatedAt
    previousTimestamp = timestamp
    return notMonotonic
  })) {
    context.addIssue({ code: 'custom', message: 'Host Operation lifecycle timestamps are not monotonic' })
  }
  if (value.state === 'succeeded' && value.result.type !== value.operation.type) {
    context.addIssue({ code: 'custom', message: 'Host Operation result type disagrees with its reference', path: ['result'] })
  }
  const expectedSourceKind = value.operation.type === 'start-agent-run' ? 'execution-dispatch' : 'control-intent'
  if (value.source.kind !== expectedSourceKind) {
    context.addIssue({ code: 'custom', message: 'Host Operation source disagrees with its reference', path: ['source'] })
  }
}) as unknown as z.ZodType<HostOperationSnapshot>

/** Effect-boundary start result, including current-admission denial. */
export const hostOperationStartResultSchema: z.ZodType<HostOperationStartResult> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), snapshot: hostOperationSnapshotSchema }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'acceptance-mismatch', 'not-current', 'source-canceled',
      'authority-revoked', 'busy', 'unavailable',
    ]),
    snapshot: hostOperationSnapshotSchema,
  }).strict(),
])

/** Post-commit Host Operation change notification. */
export const hostOperationChangeSchema: z.ZodType<HostOperationChange> = z.object({
  operation: hostOperationReferenceSchema,
  revision: safeNonnegative,
}).strict()

/** Strict read-only bound project-status request. */
export const inspectProjectRequestSchema: z.ZodType<InspectProjectRequest> = z.object({
  binding: activeHostProjectBindingSchema,
}).strict()

/** Strict exact-Commit lookup scoped to one active Resource Binding. */
export const inspectProjectCommitRequestSchema: z.ZodType<InspectProjectCommitRequest> = z.object({
  binding: activeHostProjectBindingSchema,
  commitId: gitObject,
}).strict().superRefine((value, context) => {
  const objectWidth = value.binding.expectedInspection.projection.objectFormat === 'sha1' ? 40 : 64
  if (value.commitId.length !== objectWidth) {
    context.addIssue({ code: 'custom', message: 'Commit id disagrees with binding object format' })
  }
})

/** Exact Commit presence evidence or one bounded local-boundary failure. */
export const inspectProjectCommitResultSchema: z.ZodType<InspectProjectCommitResult> = z.union([
  z.object({ ok: z.literal(true), commitId: gitObject }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['binding-stale', 'commit-missing', 'unavailable']),
  }).strict(),
])

const successfulInspectProjectResultSchema = z.object({
  ok: z.literal(true),
  observation: projectGitStatusObservationSchema,
  preEffectBaseline: inheritedChangeBaselineSchema,
}).strict().superRefine((value, context) => {
  const baselineUnavailable = value.preEffectBaseline.kind === 'unavailable'
  const reportedUnavailable = new Set<string>(value.observation.structuredMutation.blockers)
    .has('baseline-unavailable')
  if (baselineUnavailable !== reportedUnavailable) {
    context.addIssue({
      code: 'custom',
      message: 'fresh baseline availability disagrees with structured mutation blockers',
      path: ['observation', 'structuredMutation'],
    })
  }
})

/** Closed Host bound project-status result. */
export const inspectProjectResultSchema: z.ZodType<InspectProjectResult> = z.union([
  successfulInspectProjectResultSchema,
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'binding-stale', 'missing', 'malformed', 'limit', 'invalid-path', 'ambiguous', 'unavailable',
    ]),
  }).strict(),
])

/** Closed Host inspection result. */
export const inspectProjectSelectionResultSchema: z.ZodType<InspectProjectSelectionResult> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), inspection: projectSelectionInspectionSchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum([
    'missing', 'not-directory', 'not-git', 'bare', 'prunable', 'ambiguous', 'malformed', 'unavailable',
  ]) }).strict(),
])

/**
 * Test whether text is one exact UTF-8 Git path below the repository root.
 * Control characters are valid filename data; NUL and traversal segments are not.
 * @param value - candidate Git path text after fatal UTF-8 decoding.
 * @returns whether the text is a bounded repository-relative Git path.
 */
export function isRepositoryRelativeGitPath(value: string): boolean {
  if (value === '' || value.includes('\0') || !value.isWellFormed()
    || UTF8.encode(value).byteLength > MAX_PROJECT_GIT_STATUS_PATH_BYTES
    || /^[A-Za-z]:/u.test(value) || value.startsWith('\\')) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Compare decoded Git paths by their original canonical UTF-8 byte order.
 * @param left - first valid repository-relative Git path.
 * @param right - second valid repository-relative Git path.
 * @returns negative, zero, or positive ordering result.
 */
export function compareRepositoryRelativeGitPaths(left: string, right: string): number {
  const leftBytes = UTF8.encode(left)
  const rightBytes = UTF8.encode(right)
  const commonLength = Math.min(leftBytes.byteLength, rightBytes.byteLength)
  const leftView = new DataView(leftBytes.buffer, leftBytes.byteOffset, leftBytes.byteLength)
  const rightView = new DataView(rightBytes.buffer, rightBytes.byteOffset, rightBytes.byteLength)
  for (let index = 0; index < commonLength; index += 1) {
    const difference = leftView.getUint8(index) - rightView.getUint8(index)
    if (difference !== 0) return difference
  }
  return leftBytes.byteLength - rightBytes.byteLength
}

/**
 * Test whether a remote coordinate is the canonical credential-free form.
 * @param value - candidate `authority/repository-path` string.
 * @returns whether the value satisfies the closed normalized grammar.
 */
export function isNormalizedRemoteCoordinate(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REMOTE_COORDINATE_CHARS
    || /[\s\\@?#]/u.test(value)) return false
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return false
  const authority = value.slice(0, slash)
  const path = value.slice(slash + 1)
  if (!normalizedAuthority(authority) || path.endsWith('.git')) return false
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'
    && /^(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-F]{2})+$/u.test(segment))
}

/**
 * Test the cross-platform structural forms admitted for a trusted absolute Host path.
 * Same-Host canonical identity and realpath checks remain execution-provider observations.
 * @param value - candidate POSIX, Windows drive, or Windows UNC absolute path.
 * @returns whether the value is absolute, NUL-free, and free of noncanonical path segments.
 */
export function isAbsoluteHostPath(value: string): boolean {
  if (value === '' || value.includes('\0')) return false
  if (value.startsWith('/')) {
    if (value === '/') return true
    return value.slice(1).split('/').every(component => component !== '' && component !== '.' && component !== '..')
  }
  if (/^[A-Za-z]:\\/u.test(value)) {
    if (value.includes('/')) return false
    const tail = value.slice(3)
    return tail === '' || tail.split('\\').every(component => component !== '' && component !== '.' && component !== '..')
  }
  if (value.startsWith('\\\\') && !value.includes('/')) {
    const shareRootWithSeparator = value.endsWith('\\')
    const components = value.slice(2, shareRootWithSeparator ? -1 : undefined).split('\\')
    return components.length >= 2
      && (!shareRootWithSeparator || components.length === 2)
      && components[0] !== '?'
      && components.every(component => component !== '' && component !== '.' && component !== '..')
  }
  return false
}

/**
 * Produce the unique canonical tuple key for one safe remote observation.
 * @param value - structurally valid credential-free remote observation.
 * @returns transport and optional coordinate framed without ambiguity.
 */
export function safeGitRemoteObservationKey(value: {
  readonly transport: SafeGitRemoteObservation['transport']
  readonly coordinate?: string | undefined
}): string {
  return `${value.transport}\0${value.coordinate === undefined ? '0' : `1${value.coordinate}`}`
}

/**
 * Derive canonical public-GitHub repository candidates from safe remotes.
 * @param remotes - unique sanitized remote observations from one worktree.
 * @returns sorted unique lowercase `github.com/owner/repository` coordinates.
 */
export function deriveGitHubRepositoryCandidates(
  remotes: readonly {
    readonly transport: SafeGitRemoteObservation['transport']
    readonly coordinate?: string | undefined
  }[],
): string[] {
  const candidates = new Set<string>()
  for (const remote of remotes) {
    if ((remote.transport !== 'https' && remote.transport !== 'ssh') || remote.coordinate === undefined) continue
    const match = /^(?:github\.com(?::[1-9][0-9]{0,4})?|ssh\.github\.com:443)\/([^/]+)\/([^/]+)$/u
      .exec(remote.coordinate)
    if (match === null) continue
    if (remote.transport !== 'ssh' && remote.coordinate.startsWith('ssh.github.com:')) continue
    const candidate = `github.com/${match[1]}/${match[2]}`.toLowerCase()
    if (isNormalizedRemoteCoordinate(candidate)) candidates.add(candidate)
  }
  return [...candidates].sort()
}

/**
 * Compare safe remote observations by their protocol-owned canonical tuple.
 * @param left - first remote observation.
 * @param right - second remote observation.
 * @returns negative, zero, or positive deterministic ordering result.
 */
export function compareSafeGitRemoteObservations(
  left: { readonly transport: SafeGitRemoteObservation['transport']; readonly coordinate?: string | undefined },
  right: { readonly transport: SafeGitRemoteObservation['transport']; readonly coordinate?: string | undefined },
): number {
  const leftKey = safeGitRemoteObservationKey(left)
  const rightKey = safeGitRemoteObservationKey(right)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

/**
 * Test whether a repository label is safe for direct browser display.
 * @param value - candidate non-authoritative display label.
 * @returns whether the label excludes control and formatting code points.
 */
export function isSafeDisplayLocation(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_DISPLAY_LOCATION_CHARS
    && !unsafeDisplayCodePoint.test(value)
    && !/[\\/:]/u.test(value)
    && value !== '.'
    && value !== '..'
}

/**
 * Test whether a short local branch name satisfies Git ref and display rules.
 * @param value - candidate branch name without the `refs/heads/` prefix.
 * @returns whether the value is a safe one-level-or-deeper branch name.
 */
export function isSafeGitBranchName(value: string): boolean {
  return value.length <= MAX_GIT_REF_CHARS - 'refs/heads/'.length
    && !value.startsWith('-')
    && validGitRefName(value)
}

/**
 * Test whether a full Git ref satisfies the closed projected ref grammar.
 * @param value - candidate full ref such as `refs/remotes/origin/main`.
 * @returns whether the value is a safe canonical full ref.
 */
export function isSafeGitRef(value: string): boolean {
  return value.startsWith('refs/') && value.slice('refs/'.length).includes('/')
    && validGitRefName(value)
}

function validGitRefName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_GIT_REF_CHARS
    || unsafeDisplayCodePoint.test(value)
    || /[\u0000-\u0020\u007f~^:?*\\]/u.test(value)
    || value.includes('[')
    || value === '@'
    || value.includes('..')
    || value.includes('@{')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.includes('//')) return false
  return value.split('/').every(component => component.length > 0
    && !component.startsWith('.')
    && !component.endsWith('.lock'))
}

function normalizedAuthority(authority: string): boolean {
  if (authority.startsWith('[')) {
    if (!/^\[[0-9a-f:.]+\](?::[1-9][0-9]{0,4})?$/u.test(authority)) return false
    try {
      const url = new URL(`https://${authority}/`)
      return url.host === authority && validPort(url.port)
    } catch {
      return false
    }
  }
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/u.exec(authority)
  if (match === null || !validPort(match[2] ?? '')) return false
  const host = match[1]
  return host !== undefined
    && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
}

function validPort(port: string): boolean {
  return port === '' || (String(Number(port)) === port && Number(port) >= 1 && Number(port) <= 65_535)
}
