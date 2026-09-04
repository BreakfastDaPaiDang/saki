/** Durable Local Host Operation records. @module @breakfastdapaidang/saki-execution-local/operation-state */

import { constants as bufferConstants } from 'node:buffer'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import {
  canonicalDigest,
  commitHostOperationRequestSchema,
  commitHostOperationResultSchema,
  hostOperationRequestSchema,
  hostOperationRequestV2Schema,
  hostOperationSnapshotSchema,
  isRepositoryRelativeGitPath,
  MAX_GIT_REF_CHARS,
  MAX_HOST_OPERATION_SELECTED_CHANGES,
  MAX_PROJECT_GIT_STATUS_PATH_BYTES,
  projectGitChangeFingerprintSchema,
  projectGitChangeIdSchema,
  pushBranchHostOperationResultSchema,
  stageFilesHostOperationRequestSchema,
  stageFilesHostOperationResultSchema,
  startAgentRunHostOperationRequestSchema,
  startAgentRunHostOperationResultSchema,
  unstageFilesHostOperationRequestSchema,
  unstageFilesHostOperationResultSchema,
  type AppliedProjectGitChange,
  type CommitHostOperationResult,
  type HostOperationId,
  type HostOperationRequest,
  type HostOperationRequestFingerprint,
  type HostOperationSnapshot,
  type PushBranchHostOperationRequest,
  type PushBranchHostOperationResult,
  type StageFilesHostOperationResult,
  type StartAgentRunHostOperationRequest,
  type StartAgentRunHostOperationRequestV2,
  type StartAgentRunHostOperationResult,
  type UnstageFilesHostOperationResult,
} from '@breakfastdapaidang/saki-execution'
import { defineDomain, defineDomainMigrations, domainTable } from '@deepseek-ai/dsh-storage-domain'

const UTF8 = new TextEncoder()
const MAX_INDEX_EFFECT_PATH_BASE64_CHARS = 4 * Math.ceil(MAX_PROJECT_GIT_STATUS_PATH_BYTES / 3)
const MAX_CANONICAL_UINT64_DECIMAL = '18446744073709551615'
const INDEX_LOCK_MARKER_PREFIX = 'saki-host-operation-index-lock/v1\0'

/**
 * Build the exact operation-owned index marker retained by Commit plans.
 * @param operationId - durable Host Operation identity.
 * @param requestFingerprint - immutable request fingerprint digest.
 * @returns exact marker bytes shared by runtime ownership and durable validation.
 * @internal
 */
export function localHostOperationIndexLockMarker(operationId: string, requestFingerprint: string): Buffer {
  return Buffer.from(`${INDEX_LOCK_MARKER_PREFIX}${operationId}\0${requestFingerprint}\0`, 'utf8')
}

/** Smallest index-byte bound that can retain every valid Commit lock marker. */
export const MIN_OPERATION_MAX_INDEX_BYTES = localHostOperationIndexLockMarker(
  'host-operation-00000000-0000-4000-8000-000000000000',
  '0'.repeat(64),
).byteLength

/**
 * Derive the only valid durable Agent Run result from its immutable request.
 * @param request - exact immutable StartAgentRun request.
 * @returns the correlated durable Run, Work Session, Session, and input identities.
 */
export function localHostAgentRunResultFor(
  request: StartAgentRunHostOperationRequest,
): StartAgentRunHostOperationResult {
  return {
    type: 'start-agent-run',
    agentRunId: request.run.agentRunId,
    workSessionId: request.run.workSessionId,
    sessionId: request.run.sessionId,
    inputMessageId: request.run.input.id,
  }
}

/** Return the decoded size of non-empty canonical Base64 without allocating its bytes. */
function canonicalBase64DecodedByteLength(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const dataLength = value.length - padding
  let lastSextet = 0
  for (let index = 0; index < dataLength; index += 1) {
    const sextet = base64Sextet(value.charCodeAt(index))
    if (sextet === undefined) return undefined
    lastSextet = sextet
  }
  if (padding === 2 && (lastSextet & 0x0f) !== 0) return undefined
  if (padding === 1 && (lastSextet & 0x03) !== 0) return undefined
  return value.length / 4 * 3 - padding
}

function base64Sextet(code: number): number | undefined {
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 71
  if (code >= 48 && code <= 57) return code + 4
  if (code === 43) return 62
  if (code === 47) return 63
  return undefined
}

type HistoricalGitHostOperationRequest =
  | Extract<HostOperationRequest, { readonly type: 'stage-files' | 'unstage-files' | 'commit' }>
interface LocalHostOperationRecordBase {
  readonly preparationRevision: number
  readonly snapshot: HostOperationSnapshot
}

/** Historical Git-only record retained by the version-one Host domain. */
export interface LocalHostGitOperationRecordV1 extends LocalHostOperationRecordBase {
  readonly schemaVersion: 1
  readonly request: HistoricalGitHostOperationRequest
  readonly effectPlan?: LocalHostStructuredGitOperationEffectPlan
}

/** Exact Git mutation record retained by the version-two Host domain. */
export interface LocalHostGitOperationRecordV2 extends LocalHostOperationRecordBase {
  readonly schemaVersion: 2
  readonly request: HistoricalGitHostOperationRequest
  readonly effectPlan?: LocalHostStructuredGitOperationEffectPlan
}

/** Exact Agent Run record retained by the version-two Host domain. */
export interface LocalHostAgentRunOperationRecordV2 extends LocalHostOperationRecordBase {
  readonly schemaVersion: 2
  readonly request: StartAgentRunHostOperationRequestV2
  readonly effectPlan?: LocalHostAgentRunPlan
}

/** Complete version-two Host Operation record. */
export type LocalHostOperationRecordV2 = LocalHostGitOperationRecordV2 | LocalHostAgentRunOperationRecordV2

/** Exact Git mutation record retained by the version-three Host domain. */
export interface LocalHostGitOperationRecordV3 extends LocalHostOperationRecordBase {
  readonly schemaVersion: 3
  readonly request: HistoricalGitHostOperationRequest
  readonly effectPlan?: LocalHostStructuredGitOperationEffectPlan
}

/** Exact Agent Run record retained by the version-three Host domain. */
export interface LocalHostAgentRunOperationRecordV3 extends LocalHostOperationRecordBase {
  readonly schemaVersion: 3
  readonly request: StartAgentRunHostOperationRequest
  readonly effectPlan?: LocalHostAgentRunPlan
}

/** Complete exact record retained by the version-three Host domain. */
export type LocalHostOperationRecordV3 = LocalHostGitOperationRecordV3 | LocalHostAgentRunOperationRecordV3

/** Current structured Git mutation record; its request fingerprint remains the version-one value. */
export interface LocalHostStructuredGitOperationRecord extends LocalHostOperationRecordBase {
  readonly schemaVersion: 4
  readonly request: HistoricalGitHostOperationRequest
  readonly effectPlan?: LocalHostStructuredGitOperationEffectPlan
}

/** Current exact-lease Push record. */
export interface LocalHostPushBranchOperationRecord extends LocalHostOperationRecordBase {
  readonly schemaVersion: 4
  readonly request: PushBranchHostOperationRequest
  readonly effectPlan?: LocalHostPushBranchPlan
}

/** Current Git operation record. */
export type LocalHostGitOperationRecord =
  | LocalHostStructuredGitOperationRecord
  | LocalHostPushBranchOperationRecord

/** Current Agent Run record whose external effect is reconciled from the Session log. */
export interface LocalHostAgentRunOperationRecord extends LocalHostOperationRecordBase {
  readonly schemaVersion: 4
  readonly request: StartAgentRunHostOperationRequest
  readonly effectPlan?: LocalHostAgentRunPlan
}

/** Complete private record retained before any Host Operation effect. */
export type LocalHostOperationRecord = LocalHostGitOperationRecord | LocalHostAgentRunOperationRecord

/** One private random directory whose wrapper, payload, and owner-file creation identities are durable. */
export interface LocalHostOperationScratch {
  readonly path: string
  readonly markerDigest: string
  readonly identity: { readonly device: string; readonly inode: string }
  readonly payloadIdentity: { readonly device: string; readonly inode: string }
  readonly ownerIdentity: { readonly device: string; readonly inode: string }
}

/** Exact source-index file evidence used to distinguish publication outcomes. */
export type LocalHostIndexFileEvidence =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file'; readonly digest: string; readonly byteLength: number; readonly mode: number }

/** Exact same-directory file evidence used to acquire an operation-owned index lock. */
export interface LocalHostIndexPinEvidence {
  readonly path: string
  readonly digest: string
  readonly byteLength: number
  readonly identity: { readonly device: string; readonly inode: string }
  readonly mode: number
}

interface LocalHostIndexOperationPlanBase {
  readonly kind: 'index'
  readonly scratch: LocalHostOperationScratch
  readonly indexReadLimit: number
  readonly expectedIndexFile: LocalHostIndexFileEvidence
  readonly targetIndexFile: Extract<LocalHostIndexFileEvidence, { readonly kind: 'file' }>
  readonly pin: LocalHostIndexPinEvidence
  readonly publication: 'not-started' | 'attempting' | 'applied-recorded'
  readonly changes: readonly (AppliedProjectGitChange & { readonly pathBytesBase64: string })[]
}

/** Durable StageFiles publication evidence. */
export interface LocalHostStageFilesPlan extends LocalHostIndexOperationPlanBase {
  readonly operation: 'stage-files'
  readonly result: StageFilesHostOperationResult
}

/** Durable UnstageFiles publication evidence. */
export interface LocalHostUnstageFilesPlan extends LocalHostIndexOperationPlanBase {
  readonly operation: 'unstage-files'
  readonly result: UnstageFilesHostOperationResult
}

/** Durable deterministic Commit publication evidence. */
export interface LocalHostCommitPlan {
  readonly kind: 'commit'
  readonly scratch: LocalHostOperationScratch
  readonly indexReadLimit: number
  readonly reflogReadLimit: number
  readonly publication: 'not-started' | 'attempting' | 'applied-recorded'
  readonly targetRef: string
  readonly expectedOldObjectId: string
  readonly reflogMarker: string
  readonly pin: LocalHostIndexPinEvidence
  readonly result: CommitHostOperationResult
}

/** Durable exact-lease Push publication evidence. */
export interface LocalHostPushBranchPlan {
  readonly kind: 'push-branch'
  readonly publication: 'not-started' | 'attempting' | 'applied-recorded'
  readonly result: PushBranchHostOperationResult
}

/** Provider-private effect evidence retained through terminal recovery. */
export type LocalHostStructuredGitOperationEffectPlan =
  | LocalHostStageFilesPlan
  | LocalHostUnstageFilesPlan
  | LocalHostCommitPlan

/** Provider-private effect evidence for any current Git operation. */
export type LocalHostGitOperationEffectPlan =
  | LocalHostStructuredGitOperationEffectPlan
  | LocalHostPushBranchPlan

/** Durable intent and confirmed identity for one crash-reconciled Agent Run. */
export interface LocalHostAgentRunPlan {
  readonly kind: 'agent-run'
  readonly publication: 'not-started' | 'attempting' | 'applied-recorded'
  readonly result: StartAgentRunHostOperationResult
}

/** Provider-private effect evidence retained through terminal recovery. */
export type LocalHostOperationEffectPlan = LocalHostGitOperationEffectPlan | LocalHostAgentRunPlan

/**
 * Compute the immutable identity used for one source Intent replay.
 * @param request - complete structured operation request.
 * @returns canonical versioned request fingerprint.
 */
export function localHostOperationRequestFingerprint(
  request: HostOperationRequest,
): HostOperationRequestFingerprint {
  return {
    version: 1,
    digest: canonicalDigest('saki/host-operation-request/v1', request),
  }
}

/**
 * Retain the fields shared by every Host Operation state transition.
 * @param snapshot - current durable operation snapshot.
 * @returns identity, timing, and admission fields shared with the next state.
 * @internal
 */
export function hostOperationSnapshotCore(snapshot: HostOperationSnapshot): Pick<
  HostOperationSnapshot,
  | 'operation'
  | 'revision'
  | 'source'
  | 'requestFingerprint'
  | 'bindingId'
  | 'bindingRevision'
  | 'preparedAt'
  | 'updatedAt'
  | 'admission'
> {
  return {
    operation: snapshot.operation,
    revision: snapshot.revision,
    source: snapshot.source,
    requestFingerprint: snapshot.requestFingerprint,
    bindingId: snapshot.bindingId,
    bindingRevision: snapshot.bindingRevision,
    preparedAt: snapshot.preparedAt,
    updatedAt: snapshot.updatedAt,
    admission: snapshot.admission,
  }
}

const indexEffectPlanChangesSchema = z.unknown().superRefine((value, context) => {
  if (!Array.isArray(value)) return
  if (value.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'index effect plan must contain at least one change',
      continue: false,
    })
    return
  }
  if (value.length > MAX_HOST_OPERATION_SELECTED_CHANGES) {
    context.addIssue({
      code: 'custom',
      message: 'index effect plan changes exceed the protocol row limit',
      continue: false,
    })
    return
  }
  let remainingPathBytes = MAX_PROJECT_GIT_STATUS_PATH_BYTES
  let remainingPathEvidenceBytes = MAX_PROJECT_GIT_STATUS_PATH_BYTES
  for (const [index, change] of value.entries()) {
    if (typeof change !== 'object' || change === null) continue
    const path = (change as { readonly path?: unknown }).path
    if (typeof path === 'string') {
      if (path.length > remainingPathBytes) {
        context.addIssue({
          code: 'custom',
          message: 'index effect plan paths exceed the protocol byte limit',
          path: [index, 'path'],
          continue: false,
        })
        return
      }
      const pathBytes = UTF8.encode(path).byteLength
      if (pathBytes > remainingPathBytes) {
        context.addIssue({
          code: 'custom',
          message: 'index effect plan paths exceed the protocol byte limit',
          path: [index, 'path'],
          continue: false,
        })
        return
      }
      remainingPathBytes -= pathBytes
    }
    const pathBytesBase64 = (change as { readonly pathBytesBase64?: unknown }).pathBytesBase64
    if (typeof pathBytesBase64 !== 'string') continue
    if (pathBytesBase64.length > MAX_INDEX_EFFECT_PATH_BASE64_CHARS) {
      context.addIssue({
        code: 'custom',
        message: 'index effect plan paths exceed the protocol byte limit',
        path: [index, 'pathBytesBase64'],
        continue: false,
      })
      return
    }
    const decodedBytes = canonicalBase64DecodedByteLength(pathBytesBase64)
    if (decodedBytes === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'index effect plan path bytes are not canonical base64',
        path: [index, 'pathBytesBase64'],
        continue: false,
      })
      return
    }
    if (decodedBytes > remainingPathEvidenceBytes) {
      context.addIssue({
        code: 'custom',
        message: 'index effect plan paths exceed the protocol byte limit',
        path: [index, 'pathBytesBase64'],
        continue: false,
      })
      return
    }
    remainingPathEvidenceBytes -= decodedBytes
  }
}).pipe(z.array(appliedChangeSchema())
  .min(1)
  .max(MAX_HOST_OPERATION_SELECTED_CHANGES))

const indexEffectPlanFields = {
  scratch: scratchSchema(),
  indexReadLimit: boundedReadLimitSchema(MIN_OPERATION_MAX_INDEX_BYTES),
  expectedIndexFile: indexFileEvidenceSchema(),
  targetIndexFile: indexFileEvidenceSchema().and(z.object({ kind: z.literal('file') })),
  pin: indexPinSchema(),
  publication: z.enum(['not-started', 'attempting', 'applied-recorded']),
  changes: indexEffectPlanChangesSchema,
}

const gitHostOperationRequestSchema = z.discriminatedUnion('type', [
  stageFilesHostOperationRequestSchema,
  unstageFilesHostOperationRequestSchema,
  commitHostOperationRequestSchema,
])

const hostOperationRequestV3Schema = z.discriminatedUnion('type', [
  stageFilesHostOperationRequestSchema,
  unstageFilesHostOperationRequestSchema,
  commitHostOperationRequestSchema,
  startAgentRunHostOperationRequestSchema,
])

const localHostGitOperationEffectPlanSchema = z.union([
  z.object({
    kind: z.literal('index'),
    operation: z.literal('stage-files'),
    ...indexEffectPlanFields,
    result: stageFilesHostOperationResultSchema,
  }).strict(),
  z.object({
    kind: z.literal('index'),
    operation: z.literal('unstage-files'),
    ...indexEffectPlanFields,
    result: unstageFilesHostOperationResultSchema,
  }).strict(),
  z.object({
    kind: z.literal('commit'),
    scratch: scratchSchema(),
    indexReadLimit: boundedReadLimitSchema(MIN_OPERATION_MAX_INDEX_BYTES),
    reflogReadLimit: boundedReadLimitSchema(),
    publication: z.enum(['not-started', 'attempting', 'applied-recorded']),
    targetRef: z.string().min(1).max(MAX_GIT_REF_CHARS),
    expectedOldObjectId: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u),
    reflogMarker: z.string().min(1).max(1_024),
    pin: indexPinSchema(),
    result: commitHostOperationResultSchema,
  }).strict(),
])

const localHostPushBranchPlanSchema = z.object({
  kind: z.literal('push-branch'),
  publication: z.enum(['not-started', 'attempting', 'applied-recorded']),
  result: pushBranchHostOperationResultSchema,
}).strict()

const localHostAgentRunPlanSchema = z.object({
  kind: z.literal('agent-run'),
  publication: z.enum(['not-started', 'attempting', 'applied-recorded']),
  result: startAgentRunHostOperationResultSchema,
}).strict()

function localHostOperationRecordSchemaFor(schemaVersion: 1 | 2 | 3 | 4) {
  return z.object({
    schemaVersion: z.literal(schemaVersion),
    request: schemaVersion === 1
      ? gitHostOperationRequestSchema
      : schemaVersion === 2 ? hostOperationRequestV2Schema
        : schemaVersion === 3 ? hostOperationRequestV3Schema : hostOperationRequestSchema,
    preparationRevision: z.number().int().nonnegative(),
    snapshot: hostOperationSnapshotSchema,
    effectPlan: schemaVersion === 1
      ? localHostGitOperationEffectPlanSchema.optional()
      : schemaVersion === 4
        ? z.union([
          localHostGitOperationEffectPlanSchema,
          localHostPushBranchPlanSchema,
          localHostAgentRunPlanSchema,
        ]).optional()
        : z.union([localHostGitOperationEffectPlanSchema, localHostAgentRunPlanSchema]).optional(),
  }).strict().superRefine((record, context) => {
    validateLocalHostOperationRecord(
      record as unknown as LocalHostOperationRecord | LocalHostOperationRecordV3
      | LocalHostOperationRecordV2 | LocalHostGitOperationRecordV1,
      context,
    )
  })
}

function validateLocalHostOperationRecord(
  record: LocalHostOperationRecord | LocalHostOperationRecordV3
  | LocalHostOperationRecordV2 | LocalHostGitOperationRecordV1,
  context: z.RefinementCtx,
): void {
  const snapshot = record.snapshot
  const request = record.request
  const expectedFingerprint = localHostOperationRequestFingerprint(request)
  if (snapshot.requestFingerprint.digest !== expectedFingerprint.digest) {
    context.addIssue({ code: 'custom', message: 'Host Operation request fingerprint disagrees with request' })
  }
  if (snapshot.operation.type !== request.type
    || snapshot.operation.hostId !== request.expected.binding.hostId
    || snapshot.bindingId !== request.expected.binding.id
    || snapshot.bindingRevision !== request.expected.binding.revision) {
    context.addIssue({ code: 'custom', message: 'Host Operation snapshot disagrees with request routing' })
  }
  if (canonicalDigest('saki/host-operation-source/v1', snapshot.source)
    !== canonicalDigest('saki/host-operation-source/v1', request.source)) {
    context.addIssue({ code: 'custom', message: 'Host Operation snapshot disagrees with request source' })
  }
  if (record.preparationRevision > snapshot.revision) {
    context.addIssue({ code: 'custom', message: 'Host Operation preparation revision exceeds current revision' })
  }
  if ((snapshot.state === 'publishing' || snapshot.state === 'succeeded'
    || snapshot.state === 'reconciliation-required') && record.effectPlan === undefined) {
    context.addIssue({ code: 'custom', message: `${snapshot.state} Host Operation has no durable effect plan` })
  }
  if ((snapshot.state === 'prepared' || snapshot.state === 'accepted' || snapshot.state === 'planning')
    && record.effectPlan !== undefined) {
    context.addIssue({ code: 'custom', message: `${snapshot.state} Host Operation unexpectedly has an effect plan` })
  }
  if (snapshot.state === 'succeeded' && record.effectPlan?.publication !== 'applied-recorded') {
    context.addIssue({ code: 'custom', message: 'succeeded Host Operation has no applied-recorded publication' })
  }
  if (snapshot.state === 'reconciliation-required'
    && record.effectPlan?.publication !== 'attempting'
    && record.effectPlan?.publication !== 'applied-recorded') {
    context.addIssue({ code: 'custom', message: 'reconciliation-required Host Operation has no attempted publication' })
  }
  if ((snapshot.state === 'failed' || snapshot.state === 'canceled')
    && record.effectPlan !== undefined && record.effectPlan.publication !== 'not-started') {
    context.addIssue({ code: 'custom', message: `${snapshot.state} Host Operation contradicts its no-effect evidence` })
  }
  if (record.effectPlan !== undefined && record.effectPlan.kind === 'index'
    && record.effectPlan.operation !== request.type) {
    context.addIssue({ code: 'custom', message: 'index effect plan disagrees with Host Operation type' })
  }
  if (record.effectPlan !== undefined && record.effectPlan.kind === 'commit' && request.type !== 'commit') {
    context.addIssue({ code: 'custom', message: 'Commit effect plan disagrees with Host Operation type' })
  }
  if (record.effectPlan?.kind === 'agent-run' && request.type !== 'start-agent-run') {
    context.addIssue({ code: 'custom', message: 'Agent Run effect plan disagrees with Host Operation type' })
  }
  if (record.effectPlan?.kind === 'push-branch' && request.type !== 'push-branch') {
    context.addIssue({ code: 'custom', message: 'Push effect plan disagrees with Host Operation type' })
  }
  if (request.type === 'push-branch' && record.effectPlan !== undefined
    && record.effectPlan.kind !== 'push-branch') {
    context.addIssue({ code: 'custom', message: 'Push Host Operation has a different effect plan' })
  }
  if (request.type === 'push-branch' && record.effectPlan?.kind === 'push-branch') {
    validatePushPlan(request, record.effectPlan, context)
  }
  if (request.type === 'start-agent-run' && record.effectPlan !== undefined
    && record.effectPlan.kind !== 'agent-run') {
    context.addIssue({ code: 'custom', message: 'Agent Run Host Operation has a Git effect plan' })
  }
  if (request.type === 'start-agent-run' && record.effectPlan?.kind === 'agent-run'
    && canonicalDigest('saki/host-operation-result/v1', record.effectPlan.result)
      !== canonicalDigest('saki/host-operation-result/v1', localHostAgentRunResultFor(request))) {
    context.addIssue({ code: 'custom', message: 'Agent Run effect plan result disagrees with request' })
  }
  if (snapshot.state === 'succeeded' && record.effectPlan !== undefined
    && canonicalDigest('saki/host-operation-result/v1', snapshot.result)
      !== canonicalDigest('saki/host-operation-result/v1', record.effectPlan.result)) {
    context.addIssue({ code: 'custom', message: 'Host Operation success disagrees with published effect plan' })
  }
  if (record.effectPlan?.kind === 'index' && request.type !== 'start-agent-run') {
    validateIndexPlan(record as LocalHostAnyStructuredGitOperationRecord, record.effectPlan, context)
  }
  if (record.effectPlan?.kind === 'commit' && request.type !== 'start-agent-run') {
    validateCommitPlan(record as LocalHostAnyStructuredGitOperationRecord, record.effectPlan, context)
  }
  if (record.effectPlan !== undefined && record.effectPlan.kind !== 'agent-run'
    && record.effectPlan.kind !== 'push-branch'
    && request.type !== 'start-agent-run') {
    validateOwnershipMarkers(record as LocalHostAnyStructuredGitOperationRecord, record.effectPlan, context)
  }
}

function validatePushPlan(
  request: PushBranchHostOperationRequest,
  plan: LocalHostPushBranchPlan,
  context: z.RefinementCtx,
): void {
  const expectedResult: Omit<PushBranchHostOperationResult, 'previous' | 'credential'> = {
    type: 'push-branch',
    repository: request.expected.repository,
    targetRef: request.targetRef,
    commitId: request.expected.commitId,
  }
  const { previous: _previous, credential: _credential, ...actualResult } = plan.result
  if (canonicalDigest('saki/host-operation-result/v1', actualResult)
    !== canonicalDigest('saki/host-operation-result/v1', expectedResult)) {
    context.addIssue({ code: 'custom', message: 'Push effect plan result disagrees with request' })
  }
}

type LocalHostAnyGitOperationRecord =
  | LocalHostGitOperationRecord
  | LocalHostGitOperationRecordV3
  | LocalHostGitOperationRecordV2
  | LocalHostGitOperationRecordV1

type LocalHostAnyStructuredGitOperationRecord =
  | LocalHostStructuredGitOperationRecord
  | LocalHostGitOperationRecordV3
  | LocalHostGitOperationRecordV2
  | LocalHostGitOperationRecordV1

function expectedObjectIdWidth(record: LocalHostAnyGitOperationRecord): 40 | 64 {
  return record.request.expected.binding.expectedInspection.projection.objectFormat === 'sha1' ? 40 : 64
}

const localHostOperationRecordV1Schema = localHostOperationRecordSchemaFor(1) as unknown as
  z.ZodType<LocalHostGitOperationRecordV1>
const localHostOperationRecordV2Schema = localHostOperationRecordSchemaFor(2) as unknown as
  z.ZodType<LocalHostOperationRecordV2>
const localHostOperationRecordV3Schema = localHostOperationRecordSchemaFor(3) as unknown as
  z.ZodType<LocalHostOperationRecordV3>
const localHostOperationRecordSchema = localHostOperationRecordSchemaFor(4) as unknown as
  z.ZodType<LocalHostOperationRecord>

function validateIndexPlan(
  record: LocalHostAnyStructuredGitOperationRecord,
  plan: LocalHostStageFilesPlan | LocalHostUnstageFilesPlan,
  context: z.RefinementCtx,
): void {
  if (record.request.type === 'commit') return
  const publicChanges = plan.changes.map(({ pathBytesBase64: _pathBytesBase64, ...change }) => change)
  if (canonicalDigest('saki/host-operation-plan-changes/v1', publicChanges)
    !== canonicalDigest('saki/host-operation-plan-changes/v1', plan.result.changes)) {
    context.addIssue({ code: 'custom', message: 'index effect plan changes disagree with its result' })
  }
  const selected = plan.changes.map(change => ({ id: change.id, fingerprint: change.fingerprint }))
  if (canonicalDigest('saki/host-operation-selected-changes/v1', selected)
    !== canonicalDigest('saki/host-operation-selected-changes/v1', record.request.changes)) {
    context.addIssue({ code: 'custom', message: 'index effect plan changes disagree with the request selection' })
  }
  for (const [index, change] of plan.changes.entries()) {
    let bytes: Buffer
    try {
      bytes = Buffer.from(change.pathBytesBase64, 'base64')
      if (bytes.toString('base64') !== change.pathBytesBase64
        || new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== change.path) {
        throw new Error('path evidence mismatch')
      }
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'index effect plan path bytes disagree with its safe path',
        path: ['effectPlan', 'changes', index, 'pathBytesBase64'],
      })
    }
  }
  const objectWidth = expectedObjectIdWidth(record)
  if (plan.result.resultingIndex.treeId.length !== objectWidth) {
    context.addIssue({ code: 'custom', message: 'index effect plan uses a different object format' })
  }
  if (plan.pin.digest !== plan.targetIndexFile.digest
    || plan.pin.byteLength !== plan.targetIndexFile.byteLength
    || plan.pin.mode !== plan.targetIndexFile.mode) {
    context.addIssue({ code: 'custom', message: 'index pin evidence disagrees with its target index' })
  }
  if (plan.indexReadLimit < plan.pin.byteLength
    || plan.indexReadLimit < plan.targetIndexFile.byteLength
    || plan.expectedIndexFile.kind === 'file' && plan.indexReadLimit < plan.expectedIndexFile.byteLength) {
    context.addIssue({ code: 'custom', message: 'index effect plan read limit cannot retain its evidence' })
  }
  if (plan.expectedIndexFile.kind === 'file'
    && plan.expectedIndexFile.digest === plan.targetIndexFile.digest
    && plan.expectedIndexFile.byteLength === plan.targetIndexFile.byteLength) {
    context.addIssue({ code: 'custom', message: 'index effect plan has no observable publication' })
  }
  validateIndexPinPath(record, plan.pin, context)
}

function validateCommitPlan(
  record: LocalHostAnyStructuredGitOperationRecord,
  plan: LocalHostCommitPlan,
  context: z.RefinementCtx,
): void {
  if (record.request.type !== 'commit') return
  const expectedHead = record.request.expected.head
  const objectWidth = expectedObjectIdWidth(record)
  const zeroObjectId = '0'.repeat(objectWidth)
  if (plan.result.commitId.length !== objectWidth || plan.result.treeId.length !== objectWidth
    || plan.expectedOldObjectId.length !== objectWidth
    || (plan.result.parent.kind === 'commit' && plan.result.parent.objectId.length !== objectWidth)) {
    context.addIssue({ code: 'custom', message: 'Commit effect plan uses a different object format' })
  }
  if (plan.result.treeId !== record.request.expected.index.treeId) {
    context.addIssue({ code: 'custom', message: 'Commit effect plan tree disagrees with the expected index' })
  }
  if (plan.result.commitId === plan.expectedOldObjectId) {
    context.addIssue({ code: 'custom', message: 'Commit effect plan has no observable publication' })
  }
  if (canonicalDigest('saki/host-operation-commit-signature/v1', plan.result.author)
    !== canonicalDigest('saki/host-operation-commit-signature/v1', plan.result.committer)) {
    context.addIssue({ code: 'custom', message: 'Commit effect plan uses asymmetric author and committer evidence' })
  }
  if (plan.indexReadLimit < plan.pin.byteLength) {
    context.addIssue({ code: 'custom', message: 'Commit effect plan index read limit cannot retain its pin' })
  }
  if (plan.reflogMarker !== `saki host-operation ${record.snapshot.operation.id}`) {
    context.addIssue({ code: 'custom', message: 'Commit effect plan uses an unexpected reflog marker' })
  }
  validateIndexPinPath(record, plan.pin, context)
  if (expectedHead.kind === 'unborn') {
    if (plan.expectedOldObjectId !== zeroObjectId || plan.result.parent.kind !== 'none'
      || plan.result.target.kind !== 'symbolic-ref' || plan.result.target.ref !== expectedHead.symbolicRef
      || plan.targetRef !== expectedHead.symbolicRef) {
      context.addIssue({ code: 'custom', message: 'unborn Commit effect plan disagrees with expected HEAD' })
    }
    return
  }
  if (plan.expectedOldObjectId !== expectedHead.objectId
    || plan.result.parent.kind !== 'commit' || plan.result.parent.objectId !== expectedHead.objectId) {
    context.addIssue({ code: 'custom', message: 'Commit effect plan parent disagrees with expected HEAD' })
  }
  if (expectedHead.symbolicRef === undefined) {
    if (plan.result.target.kind !== 'detached-head' || plan.targetRef !== 'HEAD') {
      context.addIssue({ code: 'custom', message: 'detached Commit effect plan disagrees with expected HEAD' })
    }
  } else if (plan.result.target.kind !== 'symbolic-ref' || plan.result.target.ref !== expectedHead.symbolicRef
    || plan.targetRef !== expectedHead.symbolicRef) {
    context.addIssue({ code: 'custom', message: 'attached Commit effect plan disagrees with expected HEAD' })
  }
}

function validateOwnershipMarkers(
  record: LocalHostAnyStructuredGitOperationRecord,
  plan: LocalHostStructuredGitOperationEffectPlan,
  context: z.RefinementCtx,
): void {
  const scratchDigest = ownershipMarkerDigest(record, 'scratch')
  if (plan.scratch.markerDigest !== scratchDigest) {
    context.addIssue({ code: 'custom', message: 'effect plan scratch marker disagrees with operation identity' })
  }
  const indexMarker = ownershipMarker(record, 'index')
  if (plan.kind === 'commit' && (plan.pin.digest !== createHash('sha256').update(indexMarker).digest('hex')
    || plan.pin.byteLength !== indexMarker.byteLength)) {
    context.addIssue({ code: 'custom', message: 'Commit index pin disagrees with operation identity' })
  }
}

function ownershipMarkerDigest(
  record: LocalHostAnyGitOperationRecord,
  kind: 'scratch' | 'index',
): string {
  return createHash('sha256').update(ownershipMarker(record, kind)).digest('hex')
}

function ownershipMarker(record: LocalHostAnyGitOperationRecord, kind: 'scratch' | 'index'): Buffer {
  if (kind === 'index') {
    return localHostOperationIndexLockMarker(
      record.snapshot.operation.id,
      record.snapshot.requestFingerprint.digest,
    )
  }
  return Buffer.from(
    `saki-host-operation-scratch/v1\0${record.snapshot.operation.id}\0${record.snapshot.requestFingerprint.digest}\0`,
    'utf8',
  )
}

function validateIndexPinPath(
  record: LocalHostAnyGitOperationRecord,
  pin: LocalHostIndexPinEvidence,
  context: z.RefinementCtx,
): void {
  const indexPath = join(
    record.request.expected.binding.expectedInspection.trusted.canonicalGitDirectory,
    'index',
  )
  const pinName = basename(pin.path)
  const expectedPrefix = `${basename(indexPath)}.saki-${record.snapshot.operation.id}-`
  if (dirname(pin.path) !== dirname(indexPath)
    || !pinName.startsWith(expectedPrefix)
    || !/^[0-9a-f]{32}\.pin$/u.test(pinName.slice(expectedPrefix.length))) {
    context.addIssue({ code: 'custom', message: 'index pin path is outside its operation-owned range' })
  }
}

function scratchSchema() {
  return z.object({
    path: z.string().min(1).max(32_768),
    markerDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    identity: ownershipIdentitySchema(),
    payloadIdentity: ownershipIdentitySchema(),
    ownerIdentity: ownershipIdentitySchema(),
  }).strict()
}

function indexFileEvidenceSchema() {
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('missing') }).strict(),
    z.object({
      kind: z.literal('file'),
      digest: z.string().regex(/^[0-9a-f]{64}$/u),
      byteLength: z.number().int().nonnegative(),
      mode: z.number().int().min(0).max(0o777),
    }).strict(),
  ])
}

function indexPinSchema() {
  return z.object({
    path: z.string().min(1).max(32_768),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    byteLength: z.number().int().nonnegative(),
    identity: ownershipIdentitySchema(),
    mode: z.number().int().min(0).max(0o777),
  }).strict()
}

function boundedReadLimitSchema(minimum = 1) {
  return z.number().int().min(minimum).max(bufferConstants.MAX_LENGTH)
}

function appliedChangeSchema() {
  return z.object({
    id: projectGitChangeIdSchema,
    fingerprint: projectGitChangeFingerprintSchema,
    path: z.string().refine(
      isRepositoryRelativeGitPath,
      'index effect plan path is not a bounded repository-relative Git path',
    ),
    pathBytesBase64: z.string().refine(
      value => canonicalBase64DecodedByteLength(value) !== undefined,
      'index effect plan path bytes are not canonical base64',
    ),
  }).strict()
}

function ownershipIdentitySchema() {
  const canonicalUnsigned64 = z.string()
    .regex(/^(?:0|[1-9]\d{0,19})$/u)
    .refine(value => value.length < 20
      || value.length === 20 && value <= MAX_CANONICAL_UINT64_DECIMAL)
  return z.object({
    device: canonicalUnsigned64,
    inode: canonicalUnsigned64,
  }).strict()
}

/** Historical Git-only Host Execution domain retained for cold migration. */
export const sakiHostExecutionV1DomainSpec = defineDomain({
  name: 'saki_host_execution',
  version: 1,
  tables: {
    operations: domainTable<HostOperationId, LocalHostGitOperationRecordV1>(localHostOperationRecordV1Schema),
  },
})

/** Exact Host Execution domain retained for cold version-two migration. */
export const sakiHostExecutionV2DomainSpec = defineDomain({
  name: 'saki_host_execution',
  version: 2,
  tables: {
    operations: domainTable<HostOperationId, LocalHostOperationRecordV2>(localHostOperationRecordV2Schema),
  },
})

/** Exact Host Execution domain retained for cold version-three migration. */
export const sakiHostExecutionV3DomainSpec = defineDomain({
  name: 'saki_host_execution',
  version: 3,
  tables: {
    operations: domainTable<HostOperationId, LocalHostOperationRecordV3>(localHostOperationRecordV3Schema),
  },
})

/** Provider-owned durability domain included in the current Saki product state. */
export const sakiHostExecutionDomainSpec = defineDomain({
  name: 'saki_host_execution',
  version: 4,
  tables: {
    operations: domainTable<HostOperationId, LocalHostOperationRecord>(localHostOperationRecordSchema),
  },
})

/** Cold migrations preserving every existing request fingerprint verbatim. */
export const sakiHostExecutionDomainMigrations = defineDomainMigrations({
  current: sakiHostExecutionDomainSpec,
  steps: [
    {
      from: sakiHostExecutionV1DomainSpec,
      to: sakiHostExecutionV2DomainSpec,
      migrate: snapshot => ({
        tables: {
          operations: Object.fromEntries(Object.entries(snapshot.tables['operations'] ?? {}).map(([id, value]) => [
            id,
            { ...(value as LocalHostGitOperationRecordV1), schemaVersion: 2 as const },
          ])),
        },
        global: null,
      }),
    },
    {
      from: sakiHostExecutionV2DomainSpec,
      to: sakiHostExecutionV3DomainSpec,
      migrate: snapshot => ({
        tables: {
          operations: Object.fromEntries(Object.entries(snapshot.tables['operations'] ?? {}).map(([id, value]) => [
            id,
            { ...(value as LocalHostOperationRecordV2), schemaVersion: 3 as const },
          ])),
        },
        global: null,
      }),
    },
    {
      from: sakiHostExecutionV3DomainSpec,
      to: sakiHostExecutionDomainSpec,
      migrate: snapshot => ({
        tables: {
          operations: Object.fromEntries(Object.entries(snapshot.tables['operations'] ?? {}).map(([id, value]) => [
            id,
            { ...(value as LocalHostOperationRecordV3), schemaVersion: 4 as const },
          ])),
        },
        global: null,
      }),
    },
  ],
})
