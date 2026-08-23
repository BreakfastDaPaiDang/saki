/** Browser-safe Saki Host API schemas and inferred wire values. @module @breakfastdapaidang/saki-host-api/wire */

import { z } from 'zod'
import {
  inheritedChangeBaselineSchema,
  isGitObjectId,
  isSafeDisplayLocation,
  isSafeGitBranchName,
  MAX_DISPLAY_LOCATION_CHARS,
  MAX_GIT_REF_CHARS,
  MAX_INVENTORY_ENTRIES,
  projectInspectionFingerprintSchema,
  projectSelectionProjectionSchema,
} from '@breakfastdapaidang/saki-execution'
import type {
  AccessProjection,
  RegisterDevelopmentProjectIntent,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiDevelopmentProjectSummary,
  SakiDevelopmentWorkspaceProjection,
  SakiHostId,
  SakiIntentReceipt,
  SakiIntentReceiptId,
  SakiPrincipalId,
  SakiProjectIndexProjection,
  SakiProjectSelectionInspectionProjection,
  SakiQuery,
  SakiQueryResult,
  SakiResourceBindingId,
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
const revision = z.number().int().nonnegative()
const projectTitle = z.string().min(1).max(200).refine(value => value.trim().length > 0)
const directoryLocator = z.string().min(1).max(32_768)
const gitHead = z.string().refine(value => isGitObjectId(value))
const gitBranch = z.string().min(1).max(MAX_GIT_REF_CHARS).refine(isSafeGitBranchName)
const displayLocation = z.string().min(1).max(MAX_DISPLAY_LOCATION_CHARS).refine(isSafeDisplayLocation)

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
]) satisfies z.ZodType<SakiQuery>

/** Strict first Control Intent request. */
export const sakiIntentRequestSchema = z.object({
  type: z.literal('register-development-project'),
  intentId,
  projectTitle,
  hostId,
  directoryLocator,
  expectedRegistryRevision: revision,
  confirmedFingerprint: projectInspectionFingerprintSchema,
  confirmedBaseline: inheritedChangeBaselineSchema,
}).strict() satisfies z.ZodType<RegisterDevelopmentProjectIntent>

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
    head: gitHead,
    branch: gitBranch.optional(),
    detached: z.boolean(),
    inheritedChangeEntryCount: revision.max(MAX_INVENTORY_ENTRIES),
    baseline: z.enum(['complete', 'unavailable']),
    automaticMutationEligible: z.boolean(),
    configurationGaps: z.array(configurationGap).max(3),
  }).strict(),
}).strict()

const projectSummarySchema = projectSummaryWireSchema.superRefine((value, context) => {
  if (value.binding.detached === (value.binding.branch !== undefined)) {
    context.addIssue({ code: 'custom', message: 'summary branch and detached state disagree' })
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
}).transform((value): SakiDevelopmentProjectSummary => {
  const { branch, ...binding } = value.binding
  return {
    ...value,
    binding: { ...binding, ...(branch === undefined ? {} : { branch }) },
  }
})

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

/** Union schema retained for callers that intentionally handle every query kind. */
export const sakiQueryResultSchema = z.union([
  sakiInspectProjectSelectionResultSchema,
  sakiProjectIndexResultSchema,
  sakiDevelopmentWorkspaceResultSchema,
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

/** Registration submission business-result schema. */
export const sakiIntentResultSchema = z.union([
  z.object({ ok: z.literal(true), receipt: confirmedReceiptSchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.literal('denied') }).strict(),
  z.object({ ok: z.literal(false), reason: z.literal('unavailable') }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.literal('unavailable'),
    receipt: preparedReceiptSchema,
  }).strict(),
  z.object({ ok: z.literal(false), reason: z.literal('conflict') }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.literal('conflict'),
    receipt: conflictReceiptSchema,
  }).strict(),
  z.object({ ok: z.literal(false), reason: z.literal('failure'), receipt: failureReceiptSchema }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.literal('reconciliation-required'),
    receipt: reconciliationReceiptSchema,
  }).strict(),
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
/** Browser result union for code that handles every protected query kind. */
export type SakiWireQueryResult = z.infer<typeof sakiQueryResultSchema>
/** Browser Control Intent inferred from the strict wire schema. */
export type SakiWireIntent = z.infer<typeof sakiIntentRequestSchema>
/** Browser registration result inferred from the strict wire schema. */
export type SakiWireIntentResult = z.infer<typeof sakiIntentResultSchema>
/** Branded Host id accepted by the browser client. */
export type SakiWireHostId = SakiHostId
/** Branded Project id accepted by the browser client. */
export type SakiWireProjectId = SakiDevelopmentProjectId
