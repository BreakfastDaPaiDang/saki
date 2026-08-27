/** Durable Local Host Operation records. @module @breakfastdapaidang/saki-execution-local/operation-state */

import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import {
  canonicalDigest,
  commitHostOperationResultSchema,
  hostOperationRequestSchema,
  hostOperationSnapshotSchema,
  MAX_GIT_REF_CHARS,
  projectGitChangeFingerprintSchema,
  projectGitChangeIdSchema,
  stageFilesHostOperationResultSchema,
  unstageFilesHostOperationResultSchema,
  type AppliedProjectGitChange,
  type CommitHostOperationResult,
  type HostOperationId,
  type HostOperationRequest,
  type HostOperationRequestFingerprint,
  type HostOperationSnapshot,
  type StageFilesHostOperationResult,
  type UnstageFilesHostOperationResult,
} from '@breakfastdapaidang/saki-execution'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Complete private record retained before any Host Operation effect. */
export interface LocalHostOperationRecord {
  readonly schemaVersion: 1
  readonly request: HostOperationRequest
  readonly preparationRevision: number
  readonly snapshot: HostOperationSnapshot
  readonly effectPlan?: LocalHostOperationEffectPlan
}

/** One private random directory whose ownership is durably attributable. */
export interface LocalHostOperationScratch {
  readonly path: string
  readonly markerDigest: string
}

/** Exact source-index file evidence used to distinguish publication outcomes. */
export type LocalHostIndexFileEvidence =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file'; readonly digest: string; readonly byteLength: number }

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
  readonly publication: 'not-started' | 'attempting' | 'applied-recorded'
  readonly targetRef: string
  readonly expectedOldObjectId: string
  readonly reflogMarker: string
  readonly pin: LocalHostIndexPinEvidence
  readonly result: CommitHostOperationResult
}

/** Provider-private effect evidence retained through terminal recovery. */
export type LocalHostOperationEffectPlan =
  | LocalHostStageFilesPlan
  | LocalHostUnstageFilesPlan
  | LocalHostCommitPlan

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

const localHostOperationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  request: hostOperationRequestSchema,
  preparationRevision: z.number().int().nonnegative(),
  snapshot: hostOperationSnapshotSchema,
  effectPlan: z.union([
    z.object({
      kind: z.literal('index'),
      operation: z.literal('stage-files'),
      scratch: scratchSchema(),
      expectedIndexFile: indexFileEvidenceSchema(),
      targetIndexFile: indexFileEvidenceSchema().and(z.object({ kind: z.literal('file') })),
      pin: indexPinSchema(),
      publication: z.enum(['not-started', 'attempting', 'applied-recorded']),
      changes: z.array(appliedChangeSchema()),
      result: stageFilesHostOperationResultSchema,
    }).strict(),
    z.object({
      kind: z.literal('index'),
      operation: z.literal('unstage-files'),
      scratch: scratchSchema(),
      expectedIndexFile: indexFileEvidenceSchema(),
      targetIndexFile: indexFileEvidenceSchema().and(z.object({ kind: z.literal('file') })),
      pin: indexPinSchema(),
      publication: z.enum(['not-started', 'attempting', 'applied-recorded']),
      changes: z.array(appliedChangeSchema()),
      result: unstageFilesHostOperationResultSchema,
    }).strict(),
    z.object({
      kind: z.literal('commit'),
      scratch: scratchSchema(),
      publication: z.enum(['not-started', 'attempting', 'applied-recorded']),
      targetRef: z.string().min(1).max(MAX_GIT_REF_CHARS),
      expectedOldObjectId: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u),
      reflogMarker: z.string().min(1).max(1_024),
      pin: indexPinSchema(),
      result: commitHostOperationResultSchema,
    }).strict(),
  ]).optional(),
}).strict().superRefine((record, context) => {
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
  if (snapshot.state === 'succeeded' && record.effectPlan !== undefined
    && canonicalDigest('saki/host-operation-result/v1', snapshot.result)
      !== canonicalDigest('saki/host-operation-result/v1', record.effectPlan.result)) {
    context.addIssue({ code: 'custom', message: 'Host Operation success disagrees with published effect plan' })
  }
  if (record.effectPlan?.kind === 'index') {
    validateIndexPlan(record as LocalHostOperationRecord, context)
  }
  if (record.effectPlan?.kind === 'commit') {
    validateCommitPlan(record as LocalHostOperationRecord, context)
  }
  if (record.effectPlan !== undefined) validateOwnershipMarkers(record as LocalHostOperationRecord, context)
}) as unknown as z.ZodType<LocalHostOperationRecord>

function validateIndexPlan(
  record: LocalHostOperationRecord,
  context: z.RefinementCtx,
): void {
  const plan = record.effectPlan
  if (plan?.kind !== 'index' || record.request.type === 'commit') return
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
  const objectWidth = record.request.expected.binding.expectedInspection.projection.objectFormat === 'sha1' ? 40 : 64
  if (plan.result.resultingIndex.treeId.length !== objectWidth) {
    context.addIssue({ code: 'custom', message: 'index effect plan uses a different object format' })
  }
  if (plan.pin.digest !== plan.targetIndexFile.digest
    || plan.pin.byteLength !== plan.targetIndexFile.byteLength) {
    context.addIssue({ code: 'custom', message: 'index pin evidence disagrees with its target index' })
  }
  validateIndexPinPath(record, plan.pin, context)
}

function validateCommitPlan(
  record: LocalHostOperationRecord,
  context: z.RefinementCtx,
): void {
  const plan = record.effectPlan
  if (plan?.kind !== 'commit' || record.request.type !== 'commit') return
  const expectedHead = record.request.expected.head
  const objectWidth = record.request.expected.binding.expectedInspection.projection.objectFormat === 'sha1' ? 40 : 64
  const zeroObjectId = '0'.repeat(objectWidth)
  if (plan.result.commitId.length !== objectWidth || plan.result.treeId.length !== objectWidth
    || plan.expectedOldObjectId.length !== objectWidth
    || (plan.result.parent.kind === 'commit' && plan.result.parent.objectId.length !== objectWidth)) {
    context.addIssue({ code: 'custom', message: 'Commit effect plan uses a different object format' })
  }
  if (plan.result.treeId !== record.request.expected.index.treeId) {
    context.addIssue({ code: 'custom', message: 'Commit effect plan tree disagrees with the expected index' })
  }
  if (canonicalDigest('saki/host-operation-commit-signature/v1', plan.result.author)
    !== canonicalDigest('saki/host-operation-commit-signature/v1', plan.result.committer)) {
    context.addIssue({ code: 'custom', message: 'Commit effect plan uses asymmetric author and committer evidence' })
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

function validateOwnershipMarkers(record: LocalHostOperationRecord, context: z.RefinementCtx): void {
  const plan = record.effectPlan
  if (plan === undefined) return
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
  record: LocalHostOperationRecord,
  kind: 'scratch' | 'index',
): string {
  return createHash('sha256').update(ownershipMarker(record, kind)).digest('hex')
}

function ownershipMarker(record: LocalHostOperationRecord, kind: 'scratch' | 'index'): Buffer {
  const label = kind === 'scratch' ? 'scratch' : `${kind}-lock`
  return Buffer.from(
    `saki-host-operation-${label}/v1\0${record.snapshot.operation.id}\0${record.snapshot.requestFingerprint.digest}\0`,
    'utf8',
  )
}

function validateIndexPinPath(
  record: LocalHostOperationRecord,
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
  }).strict()
}

function indexFileEvidenceSchema() {
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('missing') }).strict(),
    z.object({
      kind: z.literal('file'),
      digest: z.string().regex(/^[0-9a-f]{64}$/u),
      byteLength: z.number().int().nonnegative(),
    }).strict(),
  ])
}

function indexPinSchema() {
  return z.object({
    path: z.string().min(1).max(32_768),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    byteLength: z.number().int().nonnegative(),
    identity: lockIdentitySchema(),
    mode: z.number().int().min(0).max(0o777),
  }).strict()
}

function appliedChangeSchema() {
  return z.object({
    id: projectGitChangeIdSchema,
    fingerprint: projectGitChangeFingerprintSchema,
    path: z.string().min(1),
    pathBytesBase64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  }).strict()
}

function lockIdentitySchema() {
  return z.object({
    device: z.string().regex(/^\d+$/u),
    inode: z.string().regex(/^\d+$/u),
  }).strict()
}

/** Provider-owned durability domain included in the Saki product state. */
export const sakiHostExecutionDomainSpec = defineDomain({
  name: 'saki_host_execution',
  version: 1,
  tables: {
    operations: domainTable<HostOperationId, LocalHostOperationRecord>(localHostOperationRecordSchema),
  },
})
